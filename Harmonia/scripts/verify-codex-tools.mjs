// Run against a local fake inference endpoint; no real model request, credentials or messages are sent.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { codexArgs, codexEnv } from '../brain/codex.mjs';
import { codexCommand } from '../lib/codex-provider.mjs';

const config = loadConfig();
await mkdir(config.cache, { recursive: true });
const directory = await mkdtemp(path.join(config.cache, 'capability-check-'));
let captured;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method === 'POST') {
    captured = JSON.parse(body);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Intentional capability inspection; no inference', type: 'invalid_request_error' } }));
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [] })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const args = codexArgs({ ...config, model: 'gpt-5.4' }, path.join(directory, 'output.json'));
  args.splice(-1, 0, '-c', 'model_provider="harmonia_probe"',
    '-c', `model_providers.harmonia_probe={name="Local tool audit",base_url="http://127.0.0.1:${server.address().port}/v1",env_key="HARMONIA_TEST_KEY",wire_api="responses",request_max_retries=0,stream_max_retries=0}`);
  const environment = { ...codexEnv(config), CODEX_HOME: directory, HARMONIA_TEST_KEY: 'local-dummy-not-a-secret' };
  await new Promise((resolve, reject) => {
    const executable = codexCommand(config);
    const child = spawn(executable.command, [...executable.prefix, ...args], { env: environment, cwd: config.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let diagnostic = '';
    child.stderr.on('data', data => { diagnostic += data; });
    child.stdout.resume();
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error('Capability audit timed out')); }, 45000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); if (!captured) reject(new Error(`No request captured: ${diagnostic.slice(-1800)}`)); else resolve(); });
    child.stdin.end('Return a harmless JSON response; this is a local capability audit.');
  });
  const names = (captured.tools || []).map(tool => tool.name || tool.type);
  console.log('Actual model tool names:', names.join(', ') || '(none)');
  assert.deepEqual(names.filter(name => !['update_plan'].includes(name)), [], 'Filesystem, shell or external tools must not reach chat inference');
  console.log('PASS: no file-reading, shell, external service or memory tools exposed.');
} finally { server.close(); server.closeAllConnections(); await rm(directory, { recursive: true, force: true }); }
