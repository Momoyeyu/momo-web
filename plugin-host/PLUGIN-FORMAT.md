# Third-party plugins, schema 1

Import a UTF-8 JSON file through Settings → plugins. Import never executes code;
plugins are installed disabled. Enabling requires explicit trust acknowledgement.
These are **trusted local programs**, running with the user's OS privileges, not
sandboxed code. A capability declaration documents intent; it does not constrain
Node filesystem, process, or network access. Only enable authors you trust.

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "my-tools",
    "version": "1.0.0",
    "name": "My tools",
    "description": "My local MCP tools",
    "entry": "main.mjs",
    "capabilities": []
  },
  "files": {"main.mjs": "// Implement an MCP stdio server here\n"}
}
```

The entry must implement the MCP stdio JSON-RPC protocol (initialize, tools/list,
tools/call); stdout is reserved for protocol messages. Bundle dependencies into
ES modules before export. No npm installation, scripts, archives, arbitrary host
Cordis imports, or automatic dependency downloads occur. Node must be installed.
The host's existing MCP adapter owns transport lifecycle and tool projection;
Python remains the only reasoning coordinator. Ordinary tool execution still
passes existing MCP permissions. Those permissions do not restrict startup code.

Maximum serialized bundle size is 2 MiB; 1–64 text `.mjs` files; portable relative
paths only. IDs are lowercase letters/digits/hyphens, 2–63 characters and may not
start `momo-`. Versions are three numeric components. Name/description limits are
80/1000 characters. Supported capability names are defined in
`src/plugin-manifest.mjs`. All manifest fields shown above are required.

Files and enabled state persist under the private data directory's `plugins/`.
Removal disconnects the registered transport before deleting the bundle. Update
requires removal and reimport, followed by another explicit enable. An enabled
plugin starts again with the app. Bundles are not a credential storage mechanism.

API: GET `/api/extensions/plugins` returns `{plugins:[{manifest,enabled}]}`;
POST accepts the bundle and returns its disabled record. PATCH `/{id}` accepts
`{enabled:true,trustAccepted:true}` (or `{enabled:false}`), returning its record
and `runtimeSynced`. DELETE `/{id}` returns `{removed:true,runtimeSynced}`.
Invalid input and duplicate imports return HTTP 400 with `detail`.
`runtimeSynced` reports configuration synchronization, **not connection health**;
an unreachable or invalid MCP server supplies no available tools.

If runtime synchronization fails (including an exception), PATCH/DELETE returns
HTTP 409 with a diagnostic `detail`. The plugin is persisted disabled and its
files retained; GET exposes `runtimeSynced:false`,
`runtimeStatus:"stop-unconfirmed"`, `pendingAction:"disable"|"remove"`, and a
safe `runtimeError`. A failed disable must not be presented as confirmed process
termination. Retry the action after runtime recovery; successful retry clears
the diagnostic and only successful removal deletes the files.

## Working example

Import [`examples/hello-plugin.json`](examples/hello-plugin.json), review its
embedded source, then explicitly enable it. It provides `greet({name:"Momo"})`,
returning `Hello, Momo!`. The sample uses only Node's built-in readline module;
no build, npm packages, network, or credential configuration is needed. The
sample is executable MCP code, unlike the schematic placeholder above.

Capabilities accepted in schema 1: `screen.observe`, `speech.proactive`,
`computer.pointer`, `computer.keyboard`, `browser.navigate`, `network.access`,
`files.read`, `files.write`, `game.observe`, `game.move`, `game.chat`,
`game.modify`. Duplicates and unknown names are rejected. An empty list is valid
and does **not** establish a sandbox or deny OS access. Schema 1 exposes MCP
tools only; these labels do not register custom channel adapters, UI components,
or automatic event subscriptions.
