// Run in a hidden background terminal; state and output stay in the project cache.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, openSync, closeSync, writeFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { codexCommand } from '../lib/codex-provider.mjs';

const { values } = parseArgs({ options: { cwd: { type: 'string' }, 'task-file': { type: 'string' }, 'output-schema': { type: 'string' } } });
if (!values.cwd || !values['task-file']) throw new Error('Required: --cwd <project> --task-file <UTF-8 file>');
const cwd = realpathSync(values.cwd);
const prompt = readFileSync(values['task-file'], 'utf8').replace(/^\uFEFF/, '');
if (!prompt.trim()) throw new Error('Task file is empty');
const output = path.join(CACHE, 'codex-tasks', `${Date.now()}-${process.pid}`);
mkdirSync(output, { recursive: true });
const stateFile = path.join(output, 'status.json');
const save = state => writeFileSync(stateFile, JSON.stringify({ pid: process.pid, cwd, ...state }, null, 2));
const stdout = openSync(path.join(output, 'events.jsonl'), 'w');
const stderr = openSync(path.join(output, 'stderr.log'), 'w');
save({ status: 'running', startedAt: new Date().toISOString() });
console.log(output);
try {
  const executable = codexCommand({ codex: 'codex' });
  const result = spawnSync(executable.command, [...executable.prefix, 'exec', '--skip-git-repo-check', '--json',
    '--cd', cwd, '--output-last-message', path.join(output, 'result.md'),
    ...(values['output-schema'] ? ['--output-schema', realpathSync(values['output-schema'])] : []), '-'], {
    cwd, input: prompt, encoding: 'utf8', windowsHide: true, stdio: ['pipe', stdout, stderr],
  });
  save({ status: result.status === 0 ? 'completed' : 'failed', exitCode: result.status,
    ...(result.error ? { error: result.error.message } : {}), finishedAt: new Date().toISOString() });
  process.exitCode = result.status === 0 ? 0 : 1;
} catch (error) {
  save({ status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
  process.exitCode = 1;
} finally {
  closeSync(stdout); closeSync(stderr);
}
