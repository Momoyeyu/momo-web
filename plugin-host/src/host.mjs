import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { QQChannel, WeChatChannel, ChannelError, ChannelCursorStore } from './channels.mjs';

export class HostError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new HostError(code, message); };
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Only reviewed built-ins run here. Cordis scopes are lifecycle ownership, not a sandbox. */
export class PluginHost {
  constructor({ emit = () => {}, now = Date.now, stopTimeoutMs = 5000, channelStatePath = join(process.env.MOMO_DATA_DIR ?? fileURLToPath(new URL('../../data', import.meta.url)), 'private', 'channel-cursors.json') } = {}) {
    this.ctx = new Context();
    this.hostInstance = randomUUID();
    this.emit = emit;
    this.now = now;
    this.stopTimeoutMs = stopTimeoutMs;
    this.coreInstance = null;
    this.token = null;
    this.epoch = 0;
    this.paused = true;
    this.closed = false;
    this.heartbeatMs = 5000;
    this.lastHeartbeat = 0;
    this.plugins = new Map();
    this.commands = new Map();
    this.channelQuarantines = new Map();
    this.channelCursors = new ChannelCursorStore(channelStatePath);
    this.inflight = new Map();
    this.unresolved = new Map();
    this.receipts = [];
    this.receiptSeq = 0;
    this.toolVersion = 0;
    this.activity = null;
    this.mutations = Promise.resolve();
    this.configRevision = 0;
    this.callerConfigRevision = -1;
    this.ctx.provide('momoCapabilities', Object.freeze({ checkPermit: permit => this.checkPermit(permit) }));
    this.ctx.provide('momoChannels', Object.freeze({ receive: data => this.receive(data) }));
    // Brain services are deliberately unavailable to host plugins in this first slice.
    // Their public boundaries remain explicit; no provider tokens enter a model-facing tool.
    this.ctx.provide('momoCredentials', Object.freeze({ resolve: () => fail('CREDENTIAL_UNAVAILABLE', 'Credential reference is unavailable') }));
    this.watchdog = setInterval(() => {
      if (this.coreInstance && !this.paused && this.now() - this.lastHeartbeat > this.heartbeatMs) {
        this.paused = true;
        this.awaitingGrant = false;
        this.epoch++;
        void this.stopAll('heartbeat_expired').then(result => this.event('host.paused', { reason: 'heartbeat_expired', ...result }));
      }
    }, 100);
    this.watchdog.unref();
  }

  event(event, data) { this.emit({ v: 1, event, data }); }

  authenticate(token) {
    if (!this.token || typeof token !== 'string') fail('UNAUTHORIZED', 'Host authentication required');
    const left = Buffer.from(token), right = Buffer.from(this.token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) fail('UNAUTHORIZED', 'Host authentication failed');
  }

  async request(message) {
    if (this.closed) fail('CLOSED', 'Host is closed');
    if (message?.v !== 1 || !opaque(String(message?.id ?? '')) || typeof message?.method !== 'string') fail('PROTOCOL', 'Invalid protocol envelope');
    const params = message.params ?? {};
    if (message.method === 'hello') {
      if (this.coreInstance) fail('ALREADY_BOUND', 'Host already belongs to a coordinator');
      if (!opaque(params.coreInstance) || typeof params.token !== 'string' || params.token.length < 32 || params.token.length > 512) fail('PROTOCOL', 'Invalid coordinator binding');
      this.coreInstance = params.coreInstance;
      this.token = params.token;
      this.heartbeatMs = Math.max(300, Math.min(Number(params.heartbeatMs) || 5000, 30000));
      this.lastHeartbeat = this.now();
      return { hostInstance: this.hostInstance, protocolVersion: 1, heartbeatMs: this.heartbeatMs };
    }
    this.authenticate(message.token);
    switch (message.method) {
      case 'heartbeat': {
        if (!Number.isSafeInteger(params.activityEpoch) || params.activityEpoch < this.epoch) fail('STALE_EPOCH', 'Activity epoch is stale');
        // Heartbeats extend an existing grant, never unpause after failure/revocation.
        this.lastHeartbeat = this.now();
        if (!this.boundEpoch) { this.epoch = params.activityEpoch; this.boundEpoch = true; this.paused = false; }
        else if (params.activityEpoch !== this.epoch) fail('EPOCH_MISMATCH', 'Revoke before changing activity epoch');
        return { hostInstance: this.hostInstance, activityEpoch: this.epoch, paused: this.paused };
      }
      case 'revoke': {
        if (!Number.isSafeInteger(params.activityEpoch) || params.activityEpoch <= this.epoch) fail('STALE_EPOCH', 'Revocation must advance activity epoch');
        this.paused = true;
        this.awaitingGrant = false;
        this.boundEpoch = true;
        this.epoch = params.activityEpoch;
        return this.mutate(async () => {
          const result = await this.stopAll('revoked');
          // A stopped host may receive a new explicit grant; heartbeat alone cannot do so.
          this.awaitingGrant = result.stopped;
          return { ...result, activityEpoch: this.epoch };
        });
      }
      case 'grant': {
        if (this.unresolved.size || !this.awaitingGrant || params.activityEpoch !== this.epoch) fail('PAUSED', 'A successful revoke and reconciled command outcomes are required before grant');
        await Promise.all([...this.plugins.values()].filter(plugin => plugin.enabled && plugin.channel?.grant).map(plugin => plugin.channel.grant()));
        this.awaitingGrant = false;
        this.lastHeartbeat = this.now();
        this.paused = false;
        return { activityEpoch: this.epoch, paused: false };
      }
      case 'plugins.configure': {
        if (params.configurationRevision !== undefined) {
          if (!Number.isSafeInteger(params.configurationRevision) || params.configurationRevision < 0) fail('CONFIG', 'Invalid configuration revision');
          if (params.configurationRevision < this.callerConfigRevision) return this.status();
        }
        const desired = this.desiredPlugins(params.plugins);
        if (params.configurationRevision !== undefined) this.callerConfigRevision = params.configurationRevision;
        const revision = ++this.configRevision;
        // New settings withdraw execution immediately, even if an earlier plugin
        // is still connecting inside the serialized lifecycle queue.
        for (const [id, plugin] of this.plugins) {
          const config = desired.get(id);
          if (!config || JSON.stringify(config) !== plugin.fingerprint) plugin.enabled = false;
        }
        return this.mutate(() => this.configure(params, revision));
      }
      case 'plugins.listTools': return this.listTools();
      case 'plugins.callTool': return this.callTool(params);
      case 'commands.reconcile': return this.reconcileCommand(params);
      case 'channels.health': return this.channelHealth(params);
      case 'channels.send': return this.sendChannel(params);
      case 'channels.ack': return this.ackChannel(params);
      case 'virtual.receive': return this.receive(params);
      case 'virtual.deliver': return this.deliver(params);
      case 'virtual.activityStart': return this.startActivity(params);
      case 'virtual.activityRenew': return this.renewActivity(params);
      case 'virtual.activityStop': return this.stopActivity(params.commandId, 'requested');
      case 'receipts.list': return { receipts: this.receipts.filter(item => item.seq > (Number(params.after) || 0)), oldest: this.receipts[0]?.seq ?? this.receiptSeq + 1, latest: this.receiptSeq };
      case 'status': return this.status();
      case 'shutdown': await this.close(); return { stopped: true };
      default: fail('METHOD', 'Unknown host method');
    }
  }

  mutate(fn) {
    const next = this.mutations.then(fn, fn);
    this.mutations = next.catch(() => {});
    return next;
  }

  checkPermit(permit) {
    if (this.closed || this.paused || this.now() - this.lastHeartbeat > this.heartbeatMs) fail('PAUSED', 'Coordinator is paused or unavailable');
    if (!permit || permit.coreInstance !== this.coreInstance || permit.hostInstance !== this.hostInstance || permit.activityEpoch !== this.epoch) fail('STALE_PERMIT', 'Command belongs to a stale runtime');
    if (!opaque(permit.runId) || !opaque(permit.commandId) || !Number.isFinite(permit.expiresAt) || permit.expiresAt <= this.now() || permit.expiresAt > this.now() + 30000) fail('INVALID_PERMIT', 'Command permit is invalid or expired');
  }

  beginCommand(permit, kind) {
    this.checkPermit(permit);
    const previous = this.commands.get(permit.commandId);
    if (previous) fail('DUPLICATE_COMMAND', 'Command has already been accepted');
    if (this.commands.size >= 10000) fail('CAPACITY', 'Restart the host after reconciling command receipts');
    const command = { commandId: permit.commandId, runId: permit.runId, activityEpoch: permit.activityEpoch, coreInstance: this.coreInstance, hostInstance: this.hostInstance, kind };
    this.commands.set(command.commandId, command);
    return command;
  }

  receipt(command, status, extra = {}) {
    const item = { ...command, seq: ++this.receiptSeq, at: this.now(), status, stale: command.activityEpoch !== this.epoch || this.paused, ...extra };
    this.receipts.push(item);
    if (this.receipts.length > 500) this.receipts.shift();
    this.event('receipt', item);
    return item;
  }

  desiredPlugins(plugins) {
    if (!Array.isArray(plugins) || plugins.length > 64) fail('CONFIG', 'Expected at most 64 plugin configurations');
    const desired = new Map();
    for (const config of plugins) {
      if (!config || !/^[A-Za-z0-9_-]{1,64}$/.test(config.id ?? '') || !['mcp', 'virtual', 'qq', 'wechat'].includes(config.type) || desired.has(config.id)) fail('CONFIG', 'Invalid or duplicate plugin');
      if (['qq', 'wechat'].includes(config.type) && config.id !== `momo-${config.type}`) fail('CONFIG', 'Only reviewed official channel adapters are supported');
      if (config.enabled !== false) desired.set(config.id, config);
    }
    return desired;
  }

  async configure({ plugins, tolerateErrors = false }, revision) {
    if (revision !== this.configRevision) return this.status();
    const desired = this.desiredPlugins(plugins);
    const failures = [];
    const closing = [];
    for (const [id, plugin] of this.plugins) {
      const config = desired.get(id);
      if (config && JSON.stringify(config) === plugin.fingerprint && plugin.connected && plugin.enabled) continue;
      // Withdraw execution and discovery synchronously before awaiting disposal.
      this.plugins.delete(id);
      plugin.enabled = false;
      this.toolVersion++;
      closing.push(this.disposePlugin(plugin));
    }
    await Promise.all(closing);
    for (const [id, config] of desired) {
      if (revision !== this.configRevision) break;
      if (this.closed) fail('CLOSED', 'Host is closed');
      if (this.plugins.has(id)) continue;
      const plugin = { id, config, fingerprint: JSON.stringify(config), enabled: true, connected: false, tools: [], client: null, transport: null, controllers: new Set(), fiber: null };
      this.plugins.set(id, plugin);
      try {
        plugin.fiber = this.ctx.plugin({
          name: `momo-${id}`,
          inject: ['momoCapabilities', 'momoChannels', 'momoCredentials'],
          apply: async ctx => {
            await ctx.effect(async () => {
              if (config.type === 'mcp') await this.connectMcp(plugin);
              if (['qq', 'wechat'].includes(config.type)) await this.connectChannel(plugin);
              if (this.closed || !plugin.enabled) { await this.closePluginConnection(plugin); fail('CLOSED', 'Plugin was stopped during startup'); }
              plugin.connected = true;
              return () => this.closePluginConnection(plugin);
            }, 'momo persistent plugin connection');
          },
        });
        await plugin.fiber.await();
        if (!plugin.connected) fail('PLUGIN_START', 'Plugin could not start');
        this.toolVersion++;
      } catch {
        this.plugins.delete(id);
        plugin.enabled = false;
        await this.disposePlugin(plugin);
        if (!tolerateErrors) fail('PLUGIN_START', `Plugin ${id} could not start`);
        failures.push({ id, code: 'PLUGIN_START' });
      }
    }
    return { ...this.status(), failures };
  }

  async connectChannel(plugin) {
    const Channel = plugin.config.type === 'qq' ? QQChannel : WeChatChannel;
    plugin.channel = new Channel(plugin.config, {
      now: this.now,
      active: () => plugin.enabled && this.plugins.get(plugin.id) === plugin,
      onInbox: data => this.event('inbox', data),
      onState: data => {
        if (data.status === 'disconnected' || data.status === 'identity_mismatch') plugin.connected = false;
        this.event('channel.status', data);
      },
      onLateReceipt: ({ commandId, status, ...facts }) => {
        const command = this.commands.get(commandId);
        if (!command) return;
        this.unresolved.delete(commandId);
        this.receipt(command, status, { ...facts, late: true });
      },
      cursorStore: this.channelCursors,
    });
    await plugin.channel.connect();
    if (!this.paused && plugin.channel.grant) await plugin.channel.grant();
    if (this.channelQuarantines.get(plugin.id) === plugin.fingerprint) plugin.channel.quarantine();
    else this.channelQuarantines.delete(plugin.id);
  }

  async channelHealth({ pluginId }) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.channel) return { pluginId, status: 'disconnected', actualSelfId: null, capabilities: { receive: false, reply: false, proactive: false, contacts: false, history: false, groups: false }, executorQuiescent: true };
    if (plugin.config.type === 'wechat') {
      try { await plugin.channel.refreshHealth(); } catch {
        plugin.channel.remoteQuiescent = false;
        plugin.channel.state('disconnected', 'BRIDGE_UNAVAILABLE');
      }
    }
    return plugin.channel.health();
  }

  ackChannel({ pluginId, accountId, inboxId }) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.channel || plugin.config.accountId !== accountId || !opaque(inboxId)) fail('INPUT', 'Unknown channel inbox acknowledgement');
    return plugin.channel.ack(inboxId);
  }

  async sendChannel({ pluginId, accountId, peerId, text, policyRevision, permit }) {
    this.checkPermit(permit);
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.channel || !plugin.enabled || !plugin.connected || plugin.channel.quarantined) fail('PLUGIN_UNAVAILABLE', 'Channel plugin is unavailable');
    if (accountId !== plugin.config.accountId || policyRevision !== plugin.config.policyRevision) fail('STALE_CONFIG', 'Channel account or permissions have changed');
    if (!opaque(peerId) || typeof text !== 'string' || !text.trim() || text.length > 32000) fail('INPUT', 'A private recipient and text are required');
    try { plugin.channel.check(peerId, 'reply'); } catch (error) { throw new HostError(error.code ?? 'CHANNEL', error.message); }
    const command = { ...this.beginCommand(permit, 'channel.send'), pluginId, accountId, peerId, policyRevision, payloadHash: createHash('sha256').update(text).digest('hex') };
    this.commands.set(command.commandId, command);
    const controller = new AbortController(); plugin.controllers.add(controller);
    const entry = { command, controller, plugin, promise: null };
    const promise = (async () => {
      try {
        const facts = await plugin.channel.send({ peerId, text, commandId: command.commandId, signal: controller.signal, beforeDispatch: () => {
          this.checkPermit(permit);
          if (!plugin.enabled || this.plugins.get(pluginId) !== plugin || policyRevision !== plugin.config.policyRevision) throw new ChannelError('STALE_CONFIG', 'Channel permissions changed before dispatch');
        } });
        return { receipt: this.receipt(command, 'completed', facts) };
      } catch (error) {
        if (error instanceof ChannelError && error.submitted) {
          this.unresolved.set(command.commandId, command); this.paused = true; this.awaitingGrant = false;
          this.receipt(command, 'unknown', { deliveryStatus: 'unknown', requiresReconciliation: true });
          this.event('host.paused', { reason: 'unknown_command_outcome', commandId: command.commandId });
        } else this.receipt(command, 'failed', { deliveryStatus: 'not_sent' });
        throw new HostError(error instanceof ChannelError ? error.code : 'CHANNEL', error instanceof ChannelError ? error.message : 'Channel request failed');
      } finally { plugin.controllers.delete(controller); this.inflight.delete(command.commandId); }
    })();
    entry.promise = promise; this.inflight.set(command.commandId, entry);
    return promise;
  }

  async connectMcp(plugin) {
    const config = plugin.config;
    plugin.client = new Client({ name: 'momo-plugin-host', version: '0.1.0' }, { capabilities: {} });
    const client = plugin.client;
    client.onclose = () => {
      // A disposed/replaced connection must never withdraw its successor.
      if (plugin.client !== client || !plugin.connected) return;
      plugin.connected = false;
      plugin.tools = [];
      this.toolVersion++;
      this.event('tools.changed', { version: this.toolVersion, pluginId: plugin.id });
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!plugin.connected || !plugin.enabled || plugin.client !== client) return;
      try {
        const tools = await this.fetchTools(client, config);
        if (!plugin.connected || !plugin.enabled || plugin.client !== client) return;
        plugin.tools = tools;
        this.toolVersion++;
        this.event('tools.changed', { version: this.toolVersion, pluginId: plugin.id });
      } catch { /* Existing cached catalog remains usable; no provider text reaches logs. */ }
    });
    if (config.transport === 'stdio') {
      if (!opaque(config.command) || (config.args && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string')))) fail('CONFIG', 'Invalid MCP command');
      // The SDK inherits a minimal OS environment. Configured credentials remain in this child only.
      plugin.transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env: config.env, cwd: config.cwd, stderr: 'pipe' });
      // Child stderr may contain credentials or user data; do not forward it to the shell log.
      plugin.transport.stderr?.resume();
    } else {
      let url;
      try { url = new URL(config.url); } catch { fail('CONFIG', 'Invalid MCP service address'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('CONFIG', 'Invalid MCP service address');
      const options = { requestInit: { headers: config.headers ?? {} } };
      if (config.transport === 'sse') plugin.transport = new SSEClientTransport(url, options);
      else if (config.transport === 'streamable-http') plugin.transport = new StreamableHTTPClientTransport(url, options);
      else fail('CONFIG', 'Unsupported MCP transport');
    }
    try {
      await plugin.client.connect(plugin.transport, { timeout: Math.min(Number(config.connectTimeoutMs ?? config.timeoutMs) || 15000, 60000) });
      plugin.tools = await this.fetchTools(plugin.client, config);
    } catch {
      await this.closePluginConnection(plugin);
      fail('MCP_CONNECT', 'MCP connection failed');
    }
  }

  async fetchTools(client, config) {
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: Math.min(Number(config.connectTimeoutMs ?? config.timeoutMs) || 15000, 60000) });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 512 || (cursor && cursors.has(cursor)) || cursors.size > 50) fail('MCP_CATALOG', 'MCP tool catalog exceeds supported size');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) fail('MCP_CATALOG', 'MCP tool catalog contains duplicate names');
    return tools;
  }

  listTools() {
    const tools = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled || !plugin.connected) continue;
      for (const tool of plugin.tools) tools.push({ name: `${plugin.id}__${tool.name}`, description: tool.description ?? '', inputSchema: tool.inputSchema, pluginId: plugin.id, originalName: tool.name,
        ...(plugin.config.bindingFingerprint ? { configurationFingerprint: plugin.config.bindingFingerprint } : {}) });
    }
    return { version: this.toolVersion, tools };
  }

  async callTool({ name, arguments: args = {}, permit, configurationFingerprint }) {
    this.checkPermit(permit);
    const plugin = [...this.plugins.values()].find(item => item.enabled && item.connected && item.tools.some(tool => `${item.id}__${tool.name}` === name));
    if (!plugin) fail('TOOL_UNAVAILABLE', 'Tool is disabled or unavailable');
    if (plugin.config.bindingFingerprint && plugin.config.bindingFingerprint !== configurationFingerprint) fail('STALE_CONFIG', 'Tool configuration has changed');
    const originalName = plugin.tools.find(tool => `${plugin.id}__${tool.name}` === name).name;
    const command = this.beginCommand(permit, 'mcp');
    const controller = new AbortController();
    plugin.controllers.add(controller);
    const entry = { command, controller, plugin, promise: null };
    let dispatched = false;
    const promise = (async () => {
      try {
        // Final gate is adjacent to the actual external dispatch.
        this.checkPermit(permit);
        if (!plugin.enabled || !plugin.connected) fail('TOOL_UNAVAILABLE', 'Tool is disabled or unavailable');
        dispatched = true;
        const result = await plugin.client.callTool({ name: originalName, arguments: args }, CallToolResultSchema, { signal: controller.signal, timeout: Math.min(Number(plugin.config.timeoutMs) || 15000, 60000) });
        return { result, receipt: this.receipt(command, result.isError ? 'failed' : 'completed', { result }) };
      } catch (error) {
        const cancelled = controller.signal.aborted;
        if (dispatched) {
          // Transport failure says nothing about an already dispatched effect.
          // Neither another revoke nor a catalog refresh reconciles that fact.
          this.unresolved.set(command.commandId, command);
          this.paused = true;
          this.awaitingGrant = false;
          this.receipt(command, 'unknown', { requiresReconciliation: true });
          this.event('host.paused', { reason: 'unknown_command_outcome', commandId: command.commandId });
          // Keep local work owned until its bounded transport shutdown finishes;
          // a later revoke can no longer discover it after inflight is retired.
          if (plugin.config.transport === 'stdio') await this.closePluginConnection(plugin);
        } else {
          this.receipt(command, 'failed');
        }
        throw new HostError(cancelled ? 'CANCELLED' : 'MCP_CALL', dispatched ? 'Tool outcome is unknown; reconcile external state before continuing' : 'MCP tool call failed');
      } finally {
        plugin.controllers.delete(controller);
        this.inflight.delete(command.commandId);
      }
    })();
    entry.promise = promise;
    this.inflight.set(command.commandId, entry);
    return promise;
  }

  reconcileCommand({ commandId, status }) {
    if (!opaque(commandId) || !['completed', 'failed', 'closed_unknown'].includes(status)) fail('INPUT', 'An observed terminal command outcome is required');
    if (this.inflight.has(commandId)) fail('BUSY', 'Command execution has not settled');
    const command = this.unresolved.get(commandId);
    // A coordinator may reconcile a durable command belonging to a previous host.
    if (!command) return { reconciled: false };
    if (status === 'closed_unknown') {
      const plugin = this.plugins.get(command.pluginId);
      if (!plugin?.channel || plugin.channel.health().executorQuiescent !== true) fail('BUSY', 'Channel executor is not confirmed stopped');
      this.channelQuarantines.set(plugin.id, plugin.fingerprint);
      plugin.channel.quarantine();
    }
    this.unresolved.delete(commandId);
    return { reconciled: true, receipt: this.receipt(command, status, { reconciled: true, ...(status === 'closed_unknown' ? { deliveryStatus: 'unknown', executorQuiescent: true } : {}) }) };
  }

  receive({ messageId, text, accountId = 'virtual' }) {
    if (!opaque(messageId) || !opaque(accountId) || typeof text !== 'string' || text.length > 32000) fail('INPUT', 'Invalid virtual message');
    if (![...this.plugins.values()].some(item => item.config.type === 'virtual' && item.enabled && item.connected)) fail('PLUGIN_UNAVAILABLE', 'Virtual channel is disabled');
    const data = { source: 'virtual', externalMessageId: messageId, accountId, text, receivedAt: this.now() };
    this.event('inbox', data);
    return { accepted: true };
  }

  deliver({ text, permit }) {
    if (typeof text !== 'string' || text.length > 32000) fail('INPUT', 'Invalid virtual delivery');
    if (![...this.plugins.values()].some(item => item.config.type === 'virtual' && item.enabled && item.connected)) fail('PLUGIN_UNAVAILABLE', 'Virtual channel is disabled');
    const command = this.beginCommand(permit, 'virtual.delivery');
    this.checkPermit(permit);
    return this.receipt(command, 'delivered', { text });
  }

  startActivity({ permit, tickMs = 100 }) {
    if (this.activity) fail('ACTIVITY_BUSY', 'An activity is already running');
    if (![...this.plugins.values()].some(item => item.config.type === 'virtual' && item.enabled && item.connected)) fail('PLUGIN_UNAVAILABLE', 'Virtual activity is disabled');
    const command = this.beginCommand(permit, 'virtual.activity');
    const activity = { command, permit, ticks: 0, timer: null };
    activity.timer = setInterval(() => {
      try { this.checkPermit(activity.permit); } catch { void this.stopActivity(command.commandId, 'permit_expired'); return; }
      activity.ticks++;
      this.event('activity.tick', { ...command, ticks: activity.ticks });
    }, Math.max(10, Math.min(Number(tickMs) || 100, 1000)));
    this.activity = activity;
    this.receipt(command, 'started');
    return { commandId: command.commandId, started: true };
  }

  renewActivity({ permit }) {
    this.checkPermit(permit);
    const activity = this.activity;
    if (!activity || activity.command.commandId !== permit.commandId || activity.command.runId !== permit.runId) fail('ACTIVITY_UNAVAILABLE', 'Activity is no longer active');
    activity.permit = permit;
    return { commandId: permit.commandId, expiresAt: permit.expiresAt };
  }

  async stopActivity(commandId, reason) {
    const activity = this.activity;
    if (!activity || (commandId && commandId !== activity.command.commandId)) return { stopped: true, ticks: 0 };
    clearInterval(activity.timer);
    this.activity = null;
    const receipt = this.receipt(activity.command, 'stopped', { reason, ticks: activity.ticks });
    this.event('activity.stopped', receipt);
    return { stopped: true, ticks: activity.ticks };
  }

  async closePluginConnection(plugin) {
    for (const controller of plugin.controllers) controller.abort();
    await plugin.channel?.close();
    plugin.connected = false;
    plugin.tools = [];
    const client = plugin.client;
    plugin.client = null;
    try { await client?.close(); } catch { /* Never include provider error bodies or headers. */ }
    try { await plugin.transport?.close(); } catch { /* Dispose is best effort; stop ACK below is bounded. */ }
    plugin.transport = null;
  }

  async disposePlugin(plugin) {
    if (plugin.config.type === 'virtual') await this.stopActivity(undefined, 'plugin_disabled');
    if (plugin.fiber) await plugin.fiber.dispose();
    else await this.closePluginConnection(plugin);
  }

  async stopAll(reason) {
    await this.stopActivity(undefined, reason);
    const active = [...this.inflight.values()];
    const channels = [...this.plugins.values()].filter(plugin => plugin.enabled && plugin.channel?.stop && plugin.config.type === 'wechat');
    const remoteUnknown = active.some(item => item.plugin.config.transport !== 'stdio');
    for (const item of active) item.controller.abort();
    const closing = [...new Set(active.map(item => item.plugin))].map(plugin => this.closePluginConnection(plugin));
    const channelStops = channels.map(plugin => plugin.channel.stop());
    const settled = Promise.allSettled([...closing, ...active.map(item => item.promise), ...channelStops]).then(results => results.every(result => result.status === 'fulfilled' && (result.value?.executorQuiescent !== false)));
    let stopTimer;
    const stopped = await Promise.race([settled, new Promise(resolve => { stopTimer = setTimeout(() => resolve(false), this.stopTimeoutMs); })]);
    clearTimeout(stopTimer);
    const unknownExternal = remoteUnknown || this.unresolved.size > 0;
    return { stopped: stopped && !unknownExternal, unknownExternal, reason };
  }

  status() {
    return { hostInstance: this.hostInstance, coreInstance: this.coreInstance, activityEpoch: this.epoch, paused: this.paused, activity: this.activity ? { commandId: this.activity.command.commandId, ticks: this.activity.ticks } : null, inflight: this.inflight.size, unresolvedCommands: [...this.unresolved.keys()], plugins: [...this.plugins.values()].map(plugin => ({ id: plugin.id, type: plugin.config.type, connected: plugin.connected, enabled: plugin.enabled, ...(plugin.channel ? { channel: plugin.channel.health() } : {}) })), toolVersion: this.toolVersion };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.paused = true;
    this.epoch++;
    clearInterval(this.watchdog);
    await this.stopAll('shutdown');
    const plugins = [...this.plugins.values()];
    this.plugins.clear();
    await Promise.allSettled(plugins.map(plugin => this.disposePlugin(plugin)));
    await this.ctx.fiber.dispose();
  }
}
