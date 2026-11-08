import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CACHE, ROOT } from '../lib/config.mjs';

test('terminal delegation passes UTF-8 via stdin, keeps global config, and records success or failure', { skip: process.platform !== 'win32' }, async t => {
  await mkdir(CACHE, { recursive: true });
  const fixture = await mkdtemp(path.join(CACHE, 'dispatch-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = path.join(fixture, 'npm/node_modules/@openai/codex/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'codex.js'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ args, prompt, home: process.env.CODEX_HOME }));
console.log('fixture event'); console.error('fixture diagnostic');
process.exit(prompt.includes('FAIL') ? 13 : 0);
`);
  for (const [fail, useSchema] of [[false, false], [false, true], [true, true]]) {
    const task = path.join(fixture, '任务.txt');
    const prompt = fail ? 'FAIL 明确失败' : '中文任务 $(不应执行) `保留原文`';
    await writeFile(task, '\uFEFF' + prompt);
    const schema = path.join(fixture, 'schema.json'); await writeFile(schema, '{"type":"object"}');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/codex-task.mjs'), '--cwd', fixture, '--task-file', task, ...(useSchema ? ['--output-schema', schema] : [])], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, APPDATA: fixture, CODEX_HOME: 'inherited-global-home' },
    });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const output = result.stdout.trim();
    t.after(() => rm(output, { recursive: true, force: true }));
    assert.ok(output.startsWith(path.join(CACHE, 'codex-tasks') + path.sep));
    const state = JSON.parse(await readFile(path.join(output, 'status.json'), 'utf8'));
    assert.equal(state.status, fail ? 'failed' : 'completed');
    assert.equal(state.exitCode, fail ? 13 : 0);
    const actual = JSON.parse(await readFile(path.join(output, 'result.md'), 'utf8'));
    assert.equal(actual.prompt, prompt);
    assert.equal(actual.home, 'inherited-global-home');
    assert.deepEqual(actual.args.slice(0, 5), ['exec', '--skip-git-repo-check', '--json', '--cd', fixture]);
    if (useSchema) assert.equal(actual.args[actual.args.indexOf('--output-schema') + 1], schema);
    else assert.equal(actual.args.includes('--output-schema'), false);
    assert.match(await readFile(path.join(output, 'stderr.log'), 'utf8'), /fixture diagnostic/);
  }
});
