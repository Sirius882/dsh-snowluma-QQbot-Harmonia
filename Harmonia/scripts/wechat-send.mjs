import path from 'node:path';
import { createIlinkClient } from '../vendor/wechat-bridge/lib/ilink.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readJson, allowed } from '../lib/store.mjs';
import { officialBase } from '../adapters/wechat.mjs';
import { configureNetwork } from '../lib/network.mjs';

const config = loadConfig();
await configureNetwork(config);
const [to, ...parts] = process.argv.slice(2);
const text = parts.join(' ');
if (!to || !text || text.length > 3800) throw new Error('Usage: node scripts/wechat-send.mjs <allowFrom-ID> <text, max 3800 chars>');
if (!allowed({ channel: 'wechat', kind: 'private', userId: to }, config)) throw new Error('Recipient outside allowlist');
const auth = await readJson(path.join(config.root, 'runtime/wechat-auth.json'), null);
const contacts = await readJson(path.join(config.root, 'runtime/wechat-contacts.json'), {});
if (!auth?.token || !contacts[to]?.contextToken) throw new Error('Recipient must first message the bot; login/context token required');
const client = createIlinkClient({ token: auth.token, baseUrl: officialBase(auth.baseUrl), channelVersion: auth.channelVersion });
await client.sendMessage({ to, text, contextToken: contacts[to].contextToken });
console.log('WeChat API accepted message.');
