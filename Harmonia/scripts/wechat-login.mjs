import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ENV_FILE } from '../lib/config.mjs';
import { readJson } from '../lib/store.mjs';
import { officialBase } from '../adapters/wechat.mjs';
import { patchWechatLogin } from './patch-wechat-login.mjs';
import { proxyEnv } from '../lib/network.mjs';

const config = loadConfig();
await patchWechatLogin(config.root);
const authFile = path.join(config.root, 'runtime/wechat-auth.json');
await mkdir(path.dirname(authFile), { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(config.root, 'vendor/wechat-bridge/weixin-bot.mjs'), 'login',
    '--data-dir', path.join(config.root, 'runtime/wechat'), '--auth-file', authFile, '--qr-timeout-ms', '480000'],
  { stdio: 'inherit', cwd: config.root, env: { ...process.env, ...proxyEnv(config) } });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Login failed (${code})`)));
});
const auth = await readJson(authFile, null);
if (!auth?.token || !auth.userId) throw new Error('Missing token / user ID after login');
officialBase(auth.baseUrl);
if (!config.ownerWechat) {
  if (!/^[A-Za-z0-9@._-]+$/.test(auth.userId)) throw new Error('Unexpected WeChat ID; configure manually');
  let env = await readFile(ENV_FILE, 'utf8');
  env = env.replace(/^OWNER_WECHAT_ID=.*$/m, `OWNER_WECHAT_ID=${auth.userId}`);
  env = env.replace(/^WECHAT_ALLOW_FROM=.*$/m, `WECHAT_ALLOW_FROM=${auth.userId}`);
  await writeFile(ENV_FILE, env, { mode: 0o600 });
  console.log('已把本次扫码用户写为 OWNER_WECHAT_ID 和 WECHAT_ALLOW_FROM。');
} else if (config.ownerWechat !== auth.userId) {
  console.log('扫码用户与已配置主人不同；保留原主人设置，请核对 config/.env。');
}
