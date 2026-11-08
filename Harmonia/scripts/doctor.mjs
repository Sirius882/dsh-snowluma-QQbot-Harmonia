import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { codexEnv } from '../brain/codex.mjs';
import { readJson } from '../lib/store.mjs';
import { codexCommand, syncCodexProvider } from '../lib/codex-provider.mjs';
import { createDshClient, dshStatus } from '../brain/dsh.mjs';
import { unwrap } from '../vendor/qq-bridge/src/dsh-client.js';

const config = loadConfig();
let failures = 0;
function check(label, pass) { console.log(`${pass ? 'OK' : 'NEEDS SETUP'}: ${label}`); if (!pass) failures++; }
for (const file of ['config/PERSONA.md', 'brain/response.schema.json', 'vendor/snowluma/index.mjs', 'vendor/wechat-bridge/lib/ilink.mjs']) {
  check(file, await access(path.join(config.root, file)).then(() => true, () => false));
}
for (const dir of ['runtime/codex-home', 'runtime/wechat', 'memory']) await mkdir(path.join(config.root, dir), { recursive: true });
await mkdir(path.join(config.cache, 'tmp'), { recursive: true });
check('OWNER_QQ_ID / BOT_QQ_ID / QQ_GROUP_ALLOWLIST', Boolean(config.ownerQQ && config.botQQ && config.groups.length));
check('OneBot token (value not displayed)', config.token.length >= 32);
if (config.brain === 'dsh') {
  try {
    const client = createDshClient(config);
    const presets = unwrap(await client.callUnary('agentPresets/list', {}), 'presets').presets;
    check('Global DSH Web service', true);
    for (const id of ['harmonia-owner', 'harmonia-public']) check(`DSH preset ${id}`, presets.some(p => p.id === id && !p.broken));
    const state = await dshStatus(config, client);
    if (state.ready) check(`DSH global model: ${state.provider} / ${state.model}`, true);
    else console.log('PENDING USER CONFIG: open DSH Web settings and select a global model. No OpenAI/Codex login required.');
  } catch { check('Global DSH Web service / presets', false); }
} else {
const provider = syncCodexProvider(config);
const executable = codexCommand(config);
const cli = spawnSync(executable.command, [...executable.prefix, '--version'], { env: codexEnv(config), encoding: 'utf8', windowsHide: true });
check('Codex CLI executable', cli.status === 0);
if (provider.custom) {
  check(`Custom provider ${provider.provider} / ${config.model || provider.model} (no OpenAI account login required)`, true);
} else {
  const login = spawnSync(executable.command, [...executable.prefix, 'login', 'status'], { env: codexEnv(config), encoding: 'utf8', windowsHide: true });
  check('Codex authentication', login.status === 0 && !/not logged in/i.test(login.stdout + login.stderr));
}
}
if (config.wechatEnabled) {
  const auth = await readJson(path.join(config.root, 'runtime/wechat-auth.json'), null);
  check('WeChat pairing (start-wechat-login.bat)', Boolean(auth?.token));
  check('OWNER_WECHAT_ID', Boolean(config.ownerWechat));
}
const onebot = await readJson(path.join(config.root, 'vendor/snowluma/config', `onebot_${config.botQQ}.json`), null);
check('SnowLuma /ws + token configuration', onebot?.networks.wsClients.some(x => x.name === 'harmonia' && x.url === `ws://127.0.0.1:${config.port}/ws` && x.accessToken === config.token));
const persona = await readFile(path.join(config.root, 'config/PERSONA.md'), 'utf8');
check('Persona UTF-8', !persona.includes('\uFFFD'));
console.log('This checks installation/configuration only; account login and real message delivery need live verification.');
process.exitCode = failures ? 1 : 0;
