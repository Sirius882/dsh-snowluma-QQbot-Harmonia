import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function syncCodexProvider(config) {
  const result = spawnSync('python', [path.join(config.root, 'scripts/sync-codex-provider.py')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Cannot sync Codex provider; Python 3.11+ and readable config.toml required');
  config.provider = JSON.parse(result.stdout);
  return config.provider;
}
export function codexCommand(config) {
  // Windows npm shims are scripts; launch their JS entry directly without a command shell.
  const entry = path.join(process.env.APPDATA || '', 'npm/node_modules/@openai/codex/bin/codex.js');
  if (process.platform === 'win32' && ['codex', 'codex.cmd', 'codex.ps1'].includes(config.codex) && existsSync(entry)) {
    return { command: process.execPath, prefix: [entry] };
  }
  return { command: config.codex, prefix: [] };
}
