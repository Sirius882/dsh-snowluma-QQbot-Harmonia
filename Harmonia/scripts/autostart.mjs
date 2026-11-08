import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { readJson, writeJson } from '../lib/store.mjs';
import { patchSnowlumaHidden } from './patch-snowluma-hidden.mjs';

export function selectBotProcess(processes, botQQ) {
  const matches = processes.filter(p => String(p.account?.uin || p.uin) === botQQ);
  return matches.length === 1 ? matches[0] : null;
}
export function shouldAttach(process, previous) {
  if (!process || process.connected || (process.injected && process.status !== 'error')) return false;
  return previous?.pid !== process.pid || (previous.attempts || 0) < 3;
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Local API HTTP ${response.status}`);
  return response.json();
}
async function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}
async function startHidden(command, args, cwd, name, config, env = {}) {
  await mkdir(config.cache, { recursive: true });
  const out = await open(path.join(config.cache, `${name}.out.log`), 'a');
  const err = await open(path.join(config.cache, `${name}.err.log`), 'a');
  try {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env },
      windowsHide: true, detached: true, stdio: ['ignore', out.fd, err.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { await out.close(); await err.close(); }
}
export async function ensureRunning(config) {
  const stateFile = path.join(config.root, 'runtime/autostart-state.json');
  const previous = await readJson(stateFile, {});
  const state = { checkedAt: new Date().toISOString(), attachment: previous.attachment };
  try {
    const snowRoot = path.join(config.root, 'vendor/snowluma');
    if (!await portOpen(5099)) {
      await patchSnowlumaHidden(config.root);
      state.startedSnowlumaPid = await startHidden(path.join(snowRoot, 'node.exe'), ['index.mjs'], snowRoot, 'snowluma', config,
        { SNOWLUMA_LOG_DIR: path.join(config.cache, 'snowluma-logs'), SNOWLUMA_HOOK_AUTOLOAD: '0' });
    }
    if (!await portOpen(config.port)) {
      state.startedBridgePid = await startHidden(process.execPath, [path.join(config.root, 'service.mjs')], config.root, 'service', config);
    }
    if (state.startedSnowlumaPid || state.startedBridgePid) {
      for (let attempt = 0; attempt < 15; attempt++) {
        if (await portOpen(5099) && await portOpen(config.port)) break;
        await delay(1000);
      }
    }
    const base = 'http://127.0.0.1:5099';
    const login = await json(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: config.env.SNOWLUMA_WEBUI_PASSWORD }) });
    if (!login.success) throw new Error('SnowLuma WebUI authentication failed');
    const headers = { 'X-Snowluma-Token': login.token };
    try {
      const { list } = await json(`${base}/api/processes`, { headers });
      const bot = selectBotProcess(list, config.botQQ);
      state.qq = bot ? (bot.connected ? 'connected' : 'waiting-for-attachment') : 'waiting-for-bot-QQ-login';
      if (shouldAttach(bot, state.attachment)) {
        state.attachment = { pid: bot.pid, attempts: state.attachment?.pid === bot.pid ? state.attachment.attempts + 1 : 1 };
        await writeJson(stateFile, state);
        const result = await json(`${base}/api/processes/${bot.pid}/load`, { method: 'POST', headers });
        state.qq = result.success ? 'attachment-started' : 'attachment-failed';
      }
      if (bot && !bot.connected && !shouldAttach(bot, state.attachment) && state.attachment?.attempts >= 3) state.qq = 'attachment-needs-attention';
    } finally { await fetch(`${base}/api/logout`, { method: 'POST', headers, signal: AbortSignal.timeout(3000) }).catch(() => {}); }
    state.health = await json(`http://127.0.0.1:${config.port}/health`);
    if (state.health.service !== 'Harmonia') throw new Error('Bridge port occupied by another service');
  } catch (error) { state.error = error.message; }
  await writeJson(stateFile, state);
  return state;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const state = await ensureRunning(loadConfig());
  if (state.error) process.exitCode = 1;
}
