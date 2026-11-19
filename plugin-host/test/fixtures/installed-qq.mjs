import { PluginHost as CoreHost } from '../../src/host.mjs';
import * as channel from '../../src/channels.mjs';
import * as runtime from '../../src/qq-runtime.mjs';
import { createManagedQQRuntime } from '../../src/qq-invocation.mjs';

export { HostError } from '../../src/host.mjs';
export class PluginHost extends CoreHost {
  constructor(options) {
    super({ qqModule: { ...channel, ...runtime, createManagedQQRuntime }, ...options });
  }
}
