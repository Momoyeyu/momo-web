import {apiJson, jsonInit} from './http';
import {desktop} from './runtime';

export type SystemPermission = 'screen' | 'input';
export type PermissionKind = SystemPermission | 'access';
export type DesktopOperation = 'targets' | 'observe' | 'control';
export type PermissionRequest = {
  missing: PermissionKind[];
  operation: DesktopOperation;
  continueAction: () => Promise<void>;
};

let pending: PermissionRequest | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export const permissionRequestSnapshot = () => pending;
export function subscribePermissionRequest(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openPermissionRequest(request: PermissionRequest) {
  if (pending || !request.missing.length) return;
  pending = request;
  notify();
}

export function clearPermissionRequest(expected: PermissionRequest) {
  if (pending !== expected) return false;
  pending = null;
  notify();
  return true;
}

export async function checkDesktopPermissions(operation: DesktopOperation, signal?: AbortSignal): Promise<PermissionKind[]> {
  const [system, access] = await Promise.all([
    apiJson<{missing: SystemPermission[]}>('/api/computer/access/precheck', {
      ...jsonInit('POST', {operation}), signal,
    }),
    apiJson<{available: boolean; granted?: boolean | null}>('/api/computer/access', {signal}),
  ]);
  if (!Array.isArray(system.missing) || system.missing.some(key => key !== 'screen' && key !== 'input') || !access.available) throw new Error('Desktop permission status unavailable');
  return [...(access.granted === true ? [] : ['access'] as const), ...system.missing];
}

/** User-initiated operations only. Passive capture never opens a permission dialog. */
export async function withDesktopPermissions(
  operation: DesktopOperation,
  perform: () => Promise<void>,
  continueAction = perform,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!desktop()) {
    await perform();
    return true;
  }
  const defer = (missing: PermissionKind[]) => {
    if (signal?.aborted || !missing.length) return false;
    openPermissionRequest({operation, missing, continueAction});
    return true;
  };
  const missing = await checkDesktopPermissions(operation, signal);
  if (defer(missing) || signal?.aborted) return false;
  try {
    await perform();
    return true;
  } catch (error) {
    // The OS may revoke access after the precheck and before the host acts.
    const changed = await checkDesktopPermissions(operation, signal).catch(() => []);
    if (defer(changed)) return false;
    throw error;
  }
}
