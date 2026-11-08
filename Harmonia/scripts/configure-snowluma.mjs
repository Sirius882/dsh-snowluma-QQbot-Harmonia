import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { readJson, writeJson } from '../lib/store.mjs';
import { patchSnowlumaHidden } from './patch-snowluma-hidden.mjs';

const config = loadConfig();
await patchSnowlumaHidden(config.root);
if (!config.botQQ || config.token.length < 32) throw new Error('Set BOT_QQ_ID and ONEBOT_ACCESS_TOKEN first');
const file = path.join(config.root, 'vendor/snowluma/config', `onebot_${config.botQQ}.json`);
const data = await readJson(file, { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
  statusCommand: { enabled: false, swallow: false, cooldownSeconds: 5, trigger: '#sl' }, historySync: { enabled: false }, notifications: { channelIds: [] } });
const entry = { name: 'harmonia', enabled: true, url: `ws://127.0.0.1:${config.port}/ws`, role: 'Universal',
  accessToken: config.token, messageFormat: 'array', reportSelfMessage: false, reconnectIntervalMs: 5000 };
data.networks.wsClients = [...data.networks.wsClients.filter(x => x.name !== entry.name), entry];
await writeJson(file, data);
console.log(`SnowLuma reverse WS configured: ws://127.0.0.1:${config.port}/ws (token hidden)`);
