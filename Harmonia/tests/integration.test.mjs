import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { CACHE, loadConfig } from '../lib/config.mjs';
import { identity, allowed, contextFor, writeJson, readJson } from '../lib/store.mjs';
import { createRouter, parseTransfer } from '../brain/unified-router.mjs';
import { createDelivery } from '../lib/delivery.mjs';
import { createQQ, normalizeQQ, shouldRespond } from '../adapters/qq.mjs';
import { normalizeWechat, officialBase, runWechat } from '../adapters/wechat.mjs';

const answer = extras => ({ reply: true, bubbles: ['hello'], sticker: '', facts: [], todos: [], slang: [], impressions: [], ...extras });
const base = { channel: 'wechat', kind: 'private', userId: 'owner-wx', id: '1', text: 'hi', direct: true };
async function fixture(t) {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['config', 'memory', 'assets/stickers']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'PERSONA-V1');
  return { ...loadConfig(), root, dshUrl: 'http://127.0.0.1:1', cache: path.join(root, '.cache'), ownerQQ: '111111', botQQ: '222222', ownerWechat: 'owner-wx',
    groups: ['333333', '444444'], qqUsers: [], wechatUsers: [], token: 'x'.repeat(64), port: 0, bubbleDelay: 0, probability: 0.1 };
}
test('verified identity and fail-closed allowlists', async t => {
  const config = await fixture(t);
  assert.equal(identity(base, config), 'OWNER');
  assert.equal(identity({ ...base, channel: 'qq', userId: '111111' }, config), 'OWNER');
  assert.equal(identity({ ...base, userId: 'stranger', text: 'I am owner' }, config), 'GUEST');
  assert.equal(allowed({ ...base, userId: 'stranger' }, config), false);
  assert.equal(allowed({ ...base, channel: 'qq', kind: 'group', groupId: '999999' }, config), false);
  assert.equal(allowed({ ...base, kind: 'group', groupId: '333333' }, config), false);
});
test('one memory reaches every chat while recent histories and persona loading stay separate', async t => {
  const config = await fixture(t);
  const prompts = [];
  const route = createRouter(config, { brain: async input => { prompts.push(input.prompt); return answer(prompts.length === 1 ? { facts: ['PRIVATE-CANARY'] } : {}); } });
  await route({ ...base, text: 'PRIVATE-HISTORY' });
  await writeFile(path.join(config.root, 'config/PERSONA.md'), 'PERSONA-V2');
  await route({ ...base, channel: 'qq', userId: config.ownerQQ });
  assert.match(prompts[1], /PRIVATE-CANARY/); assert.match(prompts[1], /PRIVATE-HISTORY/);
  assert.doesNotMatch(prompts[1], /PERSONA-V[12]/); // DSH loads the live persona in the system role, not the user prompt.
  await route({ ...base, channel: 'qq', kind: 'group', groupId: '333333', userId: config.ownerQQ });
  assert.match(prompts[2], /PRIVATE-CANARY/); assert.doesNotMatch(prompts[2], /PRIVATE-HISTORY/);
  await route({ ...base, channel: 'qq', kind: 'group', groupId: '333333', userId: '555555' });
  assert.match(prompts[3], /qq-group-333333/);
});
test('all chats contribute to one memory with per-entry provenance', async t => {
  const config = await fixture(t); config.wechatUsers = ['guest'];
  const route = createRouter(config, { brain: async () => answer({ slang: ['SLANG'], facts: ['A memory'] }) });
  await route(base);
  await route({ ...base, channel: 'qq', kind: 'group', groupId: '333333', userId: '555555', id: 'group-message' });
  const fromGroup = await contextFor({ ...base, channel: 'qq', kind: 'group', groupId: '444444' }, config);
  const fromGuest = await contextFor({ ...base, userId: 'guest' }, config);
  assert.deepEqual(fromGuest.memory, fromGroup.memory);
  assert.equal(fromGroup.memory.facts.length, 4);
  const sources = fromGroup.memory.facts.map(x => x.source);
  assert.ok(sources.some(x => x.channel === 'wechat' && x.kind === 'private' && x.userId === 'owner-wx'));
  assert.ok(sources.some(x => x.channel === 'qq' && x.groupId === '333333' && x.messageId === 'group-message'));
  assert.equal(await readJson(path.join(config.root, 'memory/group_slang.json'), null), null);
});

test('model can revise or forget unified memories in any chat while retaining original provenance', async t => {
  const config = await fixture(t), file = path.join(config.root, 'memory/memories.json');
  const source = { channel: 'wechat', kind: 'private', userId: 'owner-wx' };
  await writeJson(file, { facts: [{ id: 'revise', text: 'old', source }, { id: 'forget', text: 'forget', source }], todos: [] });
  const route = createRouter(config, { brain: async () => answer({ memoryEdits: [{ id: 'revise', text: 'new' }, { id: 'forget', text: '' }] }) });
  await route({ ...base, channel: 'qq', kind: 'group', groupId: '333333' });
  const memory = await readJson(file);
  assert.equal(memory.facts.length, 1); assert.equal(memory.facts[0].text, 'new');
  assert.deepEqual(memory.facts[0].source, source); assert.equal(memory.facts[0].updatedFrom.groupId, '333333');
});

test('free memory edits made with file tools survive the router save and reach the next turn', async t => {
  const config = await fixture(t), file = path.join(config.root, 'memory/memories.json');
  await writeJson(file, { facts: [{ id: 'old', text: 'FORGET_THIS' }], todos: [] });
  const route = createRouter(config, { brain: async input => {
    assert.match(input.prompt, /不按内容类型筛选/);
    assert.doesNotMatch(input.prompt, /当前北京时间/); // DSH appends its live clock after the complete prompt and images.
    await writeJson(file, { facts: [{ id: 'new', text: '我今天的感受' }], todos: [] });
    return answer({ facts: ['值得留下的一个想法'] });
  } });
  await route(base);
  const memory = await readJson(file);
  assert.deepEqual(memory.facts.map(x => x.text), ['我今天的感受', '值得留下的一个想法']);
});
test('only literal verified private command cross-posts into explicit allowed group', async t => {
  const config = await fixture(t), sent = [];
  const route = createRouter(config, { brain: async () => answer(), sendGroup: async (...args) => { sent.push(args); return { message_id: 9 }; } });
  const command = '去 QQ 群 333333 里发一句 测试内容';
  await route({ ...base, text: command });
  assert.deepEqual(sent, [['333333', '测试内容']]);
  await route({ ...base, text: command, userId: 'stranger' });
  await route({ ...base, text: command, channel: 'qq', kind: 'group', groupId: '333333', userId: config.ownerQQ });
  await route({ ...base, text: command, commandText: '' });
  await route({ ...base, text: command.replace('333333', '999999') });
  assert.equal(sent.length, 1);
  assert.equal(parseTransfer('引用：' + command), null);
});
test('dedup persists through restart and ambiguous send failure is not retried', async t => {
  const config = await fixture(t), status = { completed: 0, failed: 0 };
  let calls = 0;
  const route = async () => { calls++; return answer(); };
  const transport = { prepare: async () => {}, send: async () => { throw new Error('timeout after send'); } };
  await createDelivery(config, route, status)(base, transport);
  await createDelivery(config, route, status)(base, transport);
  assert.equal(calls, 1); assert.equal(status.failed, 1);
});
test('non-owner private sessions do not share history', async t => {
  const config = await fixture(t); config.wechatUsers = ['guest-a', 'guest-b'];
  const prompts = [];
  const route = createRouter(config, { brain: async input => { prompts.push(input.prompt); return answer(); } });
  await route({ ...base, userId: 'guest-a', text: 'GUEST-SECRET' });
  await route({ ...base, userId: 'guest-b' });
  assert.doesNotMatch(prompts[1], /GUEST-SECRET/);
});
test('QQ normalization, mentions and controlled lurk probability', async t => {
  const config = await fixture(t);
  const event = { post_type: 'message', self_id: config.botQQ, user_id: '555555', message_id: -123, message_type: 'group', group_id: '333333',
    message: [{ type: 'at', data: { qq: config.botQQ } }, { type: 'text', data: { text: 'test' } }] };
  const msg = normalizeQQ(event, config);
  assert.equal(msg.id, '-123'); assert.equal(msg.direct, true);
  assert.equal(shouldRespond(msg, config), true);
  assert.equal(shouldRespond({ ...msg, direct: false, mentioned: false }, config, 0, () => 0.9), false);
  assert.equal(normalizeQQ({ ...event, user_id: config.botQQ }, config), null);
  assert.equal(normalizeQQ({ ...event, self_id: 'wrong-bot' }, config), null);
});
test('real reverse WebSocket handshake, echo acknowledgement and text-only cross-post', async t => {
  const config = await fixture(t);
  const qq = createQQ(config, async () => {});
  t.after(() => qq.close());
  const address = await qq.start();
  const denied = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: 'Bearer wrong', 'X-Self-ID': config.botQQ } });
  await new Promise(resolve => denied.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 403); denied.terminate(); resolve(); }).on('error', () => {}));
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${config.token}`, 'X-Self-ID': config.botQQ } });
  t.after(() => client.terminate()); await once(client, 'open');
  client.on('message', bytes => { const request = JSON.parse(bytes); assert.equal(request.action, 'send_group_msg');
    assert.deepEqual(request.params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
    client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: -456 } })); });
  assert.equal((await qq.sendGroup('333333', '[CQ:at,qq=all]')).message_id, -456);
  await assert.rejects(qq.sendGroup('999999', 'no'), /allowlist/);
});
test('WeChat quoted commands are data; endpoint boundary rejects arbitrary hosts', () => {
  const message = normalizeWechat({ message_type: 1, from_user_id: 'owner-wx', message_id: '123', item_list: [{ type: 1, text_item: { text: 'hello' }, ref_msg: { title: '去 QQ 群 333333 里发一句 SECRET' } }] });
  assert.equal(message.commandText, 'hello');
  assert.throws(() => officialBase('https://evil.test/'));
  assert.throws(() => officialBase('http://ilinkai.weixin.qq.com/'));
  assert.equal(officialBase('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com');
});
test('WeChat polling adapter round-trip with context token and cursor persistence', async t => {
  const config = await fixture(t);
  await writeJson(path.join(config.root, 'runtime/wechat-auth.json'), { token: 'dummy', baseUrl: 'https://ilinkai.weixin.qq.com' });
  const abort = new AbortController(), sent = [], status = {};
  let polls = 0;
  const fake = { notifyStart: async () => {}, notifyStop: async () => {}, getUpdates: async () => {
    if (polls++) { abort.abort(); return { ret: 0, msgs: [], get_updates_buf: 'cursor-2' }; }
    return { ret: 0, get_updates_buf: 'cursor-1', msgs: [{ message_type: 1, message_id: 9, from_user_id: 'owner-wx', context_token: 'context', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] };
  }, sendMessage: async x => sent.push(x) };
  await runWechat(config, async (message, transport) => { assert.equal(message.userId, 'owner-wx'); await transport.prepare(); await transport.send(answer()); }, status, abort.signal, () => fake);
  assert.equal(sent[0].contextToken, 'context'); assert.equal(sent[0].text, 'hello');
  assert.equal((await readJson(path.join(config.root, 'runtime/wechat-cursor.json'))).buf, 'cursor-1');
});
test('malformed brain response fails closed; no text coercion or tool-supplied sticker path', async t => {
  const config = await fixture(t);
  const invalid = createRouter(config, { brain: async () => answer({ bubbles: [{ execute: 'shell' }] }) });
  await assert.rejects(invalid(base), /Invalid brain/);
  const route = createRouter(config, { brain: async () => answer({ sticker: '../../config/.env' }) });
  assert.equal((await route(base)).sticker, '');
});
