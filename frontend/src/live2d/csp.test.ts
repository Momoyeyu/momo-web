import {afterEach, expect, it, vi} from 'vitest';
import {ShaderSystem} from 'pixi.js';
import './stage';
afterEach(() => vi.unstubAllGlobals());
it('initializes the installed shader system when native CSP forbids Function', () => {
  vi.stubGlobal('Function', function () { throw new EvalError('Blocked by native CSP'); });
  expect(() => (ShaderSystem.prototype as unknown as {systemCheck(): void}).systemCheck()).not.toThrow();
});
