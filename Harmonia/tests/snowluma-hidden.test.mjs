import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/config.mjs';
import { patchSnowlumaSource } from '../scripts/patch-snowluma-hidden.mjs';

test('SnowLuma application child is created hidden without changing arguments, IPC or shutdown', async () => {
  const original = await readFile(path.join(ROOT, 'vendor/snowluma/index.mjs'), 'utf8');
  const patched = patchSnowlumaSource(original);
  assert.equal(patchSnowlumaSource(patched), patched);
  const start = patched.indexOf('child = spawn(process.execPath, [');
  const end = patched.indexOf('child.once("error"', start);
  const snippet = patched.slice(start, end);
  let captured;
  const fakeProcess = { execPath: 'node.exe', execArgv: [], argv: ['node.exe', 'index.mjs'] };
  Function('spawn', 'process', 'path', 'root', 'child', snippet)(
    (...args) => { captured = args; return {}; }, fakeProcess, path, ROOT, undefined,
  );
  assert.equal(captured[2].windowsHide, true);
  assert.deepEqual(captured[2].stdio, ['inherit', 'inherit', 'inherit', 'ipc']);
  assert.equal(captured[2].env.SNOWLUMA_UPDATE_ROOT, ROOT);
  assert.throws(() => patchSnowlumaSource('unknown launcher'), /changed/);
});
