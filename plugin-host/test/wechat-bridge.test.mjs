import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

test('Mac AX bridge refuses ambiguous bindings, journals incoming duplicates and never replays uncertain sends', async () => {
  const result = await run('python3', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'wechat_bridge_test.py'], { cwd: new URL('..', import.meta.url).pathname });
  assert.match(result.stderr, /OK/);
});
