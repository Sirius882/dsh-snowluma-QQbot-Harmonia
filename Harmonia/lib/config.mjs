import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CACHE = path.resolve(ROOT, '../.cache/harmonia');
export const ENV_FILE = path.join(ROOT, 'config/.env');
export function loadConfig(file = ENV_FILE) {
  const env = parseEnv(readFileSync(file, 'utf8'));
  const list = key => (env[key] || '').split(',').map(x => x.trim()).filter(Boolean);
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  for (const key of ['OWNER_QQ_ID', 'BOT_QQ_ID']) {
    if (env[key] && !/^\d{5,12}$/.test(env[key])) throw new Error(`Invalid ${key}`);
  }
  if (list('QQ_GROUP_ALLOWLIST').some(x => !/^\d{5,12}$/.test(x))) throw new Error('Invalid QQ_GROUP_ALLOWLIST');
  const brain = env.BRAIN_TYPE || 'dsh';
  if (!['dsh', 'codex'].includes(brain)) throw new Error('BRAIN_TYPE must be dsh or codex');
  const dshUrl = env.DSH_URL || 'http://127.0.0.1:3080';
  const endpoint = new URL(dshUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search) throw new Error('DSH_URL must be a local HTTP endpoint');
  return {
    root: ROOT, cache: CACHE, env, brain, dshUrl,
    ownerQQ: env.OWNER_QQ_ID || '', botQQ: env.BOT_QQ_ID || '', ownerWechat: env.OWNER_WECHAT_ID || '',
    groups: list('QQ_GROUP_ALLOWLIST'), qqUsers: list('QQ_PRIVATE_ALLOWLIST'), wechatUsers: list('WECHAT_ALLOW_FROM'),
    port: number('PORT', 8080, 1024, 65535), token: env.ONEBOT_ACCESS_TOKEN || '',
    aliases: list('BOT_ALIASES'), probability: number('GROUP_REPLY_PROBABILITY', 0.05, 0, 1),
    cooldown: number('GROUP_COOLDOWN_MS', 90000, 0, 3600000),
    directCooldown: number('GROUP_DIRECT_COOLDOWN_MS', 8000, 0, 600000),
    timeout: number('BRAIN_TIMEOUT_MS', 180000, 1000, 600000),
    maxTurnMs: number('BRAIN_MAX_TURN_MS', 900000, 1000, 3600000),
    model: env.CODEX_MODEL || '', codex: env.CODEX_BIN || 'codex',
    bubbleDelay: number('BUBBLE_DELAY_MS', 900, 0, 10000),
    qqEnabled: env.ENABLE_QQ !== '0', wechatEnabled: env.ENABLE_WECHAT !== '0',
  };
}
