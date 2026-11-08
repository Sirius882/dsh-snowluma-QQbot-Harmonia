import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { parseDshReply } from '../brain/dsh.mjs';
import { validateReply, createRouter } from '../brain/unified-router.mjs';
import { createDelivery } from '../lib/delivery.mjs';
import { readJson } from '../lib/store.mjs';

const reply = { reply: true, bubbles: ['完整回复🙂，包含"引号"、反斜杠\\和 } ]'], sticker: '',
  facts: [], todos: [], slang: [], impressions: ['完整的记忆'] };
const prefix = JSON.stringify(reply).slice(0, -1);

test('ordinary text is one literal bubble with no inferred attachments, memory or state', () => {
  for (const text of ['我第一反应是**王安石和司马光**。\n\n这里是判断理由。', '中文 C++ and English，不拆空格。', '42', 'true', '[开心] 收到了。',
    '```js\nconst x = 1;\n```', '文件在 E:/private/report.txt，![图](E:/private/a.png)']) {
    const parsed = parseDshReply(text);
    assert.deepEqual(validateReply(parsed).bubbles, [text]);
    assert.deepEqual(parsed.facts, []); assert.equal(parsed.aliveUpdate, undefined);
    assert.equal(parsed.images, undefined); assert.equal(parsed.files, undefined); assert.equal(parsed.sticker, '');
  }
  assert.throws(() => parseDshReply('  '));
  assert.throws(() => validateReply(parseDshReply('x'.repeat(3801))), /Invalid brain response/);
});

test('separate metadata retains explicit bubbles and internal fields without exposing them', () => {
  const fields = { sticker: 'fixture.gif', facts: ['记忆'], aliveUpdate: { moodUnit: 'percent', mood: { warmth: 61 } },
    tsundereUpdate: { k: .3, delta: 0 }, sources: [{ title: '来源', url: 'https://example.com/' }] };
  const parsed = parseDshReply('正文\n```harmonia\n' + JSON.stringify(fields) + '\n```');
  assert.deepEqual(validateReply(parsed).bubbles, ['正文']);
  for (const key of Object.keys(fields)) assert.deepEqual(parsed[key], fields[key]);
  assert.deepEqual(validateReply(parseDshReply('正文\n```harmonia\n{"bubbles":["第一泡","第二泡"]}\n```')).bubbles, ['第一泡', '第二泡']);
  assert.equal(validateReply(parseDshReply('```harmonia\n{"reply":false}\n```')).reply, false);
  assert.deepEqual(validateReply(parseDshReply('```harmonia\n{"files":["E:/private/file"]}\n```')).files, ['E:/private/file']);
  assert.throws(() => validateReply(parseDshReply('正文\n```harmonia\n{"facts":[123]}\n```')), /Invalid brain response/);
});

test('damaged metadata is discarded in full while completed body survives', () => {
  for (const suffix of ['', '{"facts":["秘密"],"files":["E:/private', '{"aliveUpdate":{"mood":{"warmth":99}}',
    '{"facts":["秘密"],"broken":}\n```', '[1,2]\n```', 'null\n```']) {
    const parsed = parseDshReply('完整正文\n```harmonia\n' + suffix);
    assert.deepEqual(validateReply(parsed).bubbles, ['完整正文']);
    assert.deepEqual(parsed.facts, []); assert.equal(parsed.files, undefined); assert.equal(parsed.aliveUpdate, undefined);
  }
  assert.throws(() => parseDshReply('```harmonia\n{"files":["cut'));
});

test('incomplete reply retains completed JSON fields and discards the entire unfinished state', () => {
  for (const suffix of ['', ',', ',"unfinished', ',"aliveUpdate":',
    ',"aliveUpdate":{"mood":{"warmth":32},"intent":{"moodHint":"fl',
    ',"aliveUpdate":{"loops":[{"id":"fixture","status":']) {
    const recovered = parseDshReply(prefix + suffix);
    assert.deepEqual(validateReply(recovered).bubbles, reply.bubbles);
    assert.deepEqual(recovered.impressions, reply.impressions);
    assert.equal(recovered.aliveUpdate, undefined);
  }
  assert.deepEqual(parseDshReply('```json\n' + prefix), reply);
  assert.deepEqual(parseDshReply(prefix + ',"aliveUpdate":{"mood":{"warmth":32}}').aliveUpdate, { mood: { warmth: 32 } });
  assert.deepEqual(validateReply(parseDshReply('{"reply":true,"bubbles":["OK"]')).facts, []);
});

test('recovery never completes partial paths, memories, reply bubbles or malformed complete values', () => {
  for (const tail of [',"files":["C:\\u', ',"images":["C:/private', ',"memoryEdits":[{"id":"one","text":"unfinished',
    ',"learnStickers":[{"image":1,"caption":"unfinished']) {
    const result = parseDshReply(prefix + tail);
    assert.deepEqual(result, reply);
  }
  for (const text of ['{"reply":true,"bubbles":["cut', '{"reply":true,"bubbles":["done","cut',
    '{"reply":true,"bubbles":["bad\\x"],"sticker":""', '{"reply":true "bubbles":["missing comma"]',
    '{"reply":true,"bubbles":["ok"],"aliveUpdate":{]}', prefix + '} trailing text',
    'prose before ' + prefix, '{"bubbles":["ok"],"reply":tru', '{"reply":true,"bubbles":[]']) {
    assert.throws(() => parseDshReply(text), SyntaxError);
  }
  assert.throws(() => validateReply(parseDshReply('{"reply":true,"bubbles":["ok"],"facts":[123]')), /Invalid brain response/);
  assert.throws(() => parseDshReply('{"reply":true,"bubbles":["ok"],"extra":"' + 'x'.repeat(1024 * 1024)), SyntaxError);
});

test('complete minimal reply infers only an omitted reply flag and defaults absent empty collections', () => {
  const input = { bubbles: ['完整回复'], sticker: 'fixture.gif', aliveUpdate: { mood: { warmth: 32 } } };
  const result = validateReply(parseDshReply(JSON.stringify(input)));
  assert.equal(result.reply, true); assert.deepEqual(result.bubbles, input.bubbles);
  for (const name of ['facts', 'todos', 'slang', 'impressions', 'images', 'files', 'sources']) assert.deepEqual(result[name], []);
  assert.equal(input.reply, undefined);
  assert.equal(validateReply({ bubbles: ['hello'] }).sticker, '');
  assert.equal(validateReply({ reply: false, bubbles: [] }).reply, false);
  for (const value of [null, [], {}, { bubbles: [] }, { bubbles: 'not an array' },
    { ...input, reply: null }, { ...input, reply: 'true' }, { ...input, facts: null },
    { ...input, facts: [123] }, { ...input, sticker: {} }]) assert.throws(() => validateReply(value));
});

test('recovered reply follows normal delivery, memory provenance, validation and receipt dedup', async t => {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'recovered-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'assets/stickers'), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'fixture');
  const config = { root, brain: 'dsh', ownerQQ: '111111', qqUsers: [], groups: [] };
  let calls = 0;
  const router = createRouter(config, { brain: async () => { calls++; return parseDshReply(prefix + ',"aliveUpdate":{"loops":[{"status":'); } });
  const status = { completed: 0, failed: 0 }, sent = [];
  const delivery = createDelivery(config, router, status);
  const message = { channel: 'qq', kind: 'private', userId: '111111', id: 'fixture', text: 'hello', at: Date.now() };
  const transport = { prepare: async () => {}, send: async result => sent.push(result) };
  await delivery(message, transport); await delivery(message, transport);
  assert.equal(calls, 1); assert.equal(sent.length, 1); assert.deepEqual(sent[0].bubbles, reply.bubbles);
  assert.equal(status.completed, 1); assert.equal(status.failed, 0);
  const memory = await readJson(path.join(root, 'memory/memories.json'));
  assert.equal(memory.facts.length, 1); assert.equal(memory.facts[0].text, reply.impressions[0]);
  assert.equal(memory.facts[0].source.messageId, 'fixture');
  assert.equal((await readJson(path.join(root, 'runtime/receipts.json')))['qq:private:111111:fixture'].state, 'completed');
  assert.ok((await readFile(path.join(root, 'runtime/sessions/owner-private.json'), 'utf8')).includes('完整回复'));
});

test('group text and metadata use normal delivery, owner file checks and receipt dedup', async t => {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'text-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config')); await mkdir(path.join(root, 'assets/stickers'), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'fixture');
  const config = { root, brain: 'dsh', ownerQQ: '111111', qqUsers: [], groups: ['333333'] };
  let output = '我第一反应是王安石和司马光。', calls = 0;
  const router = createRouter(config, { brain: async () => { calls++; return parseDshReply(output); } });
  const status = { completed: 0, failed: 0 }, sent = [];
  const delivery = createDelivery(config, router, status);
  const message = { channel: 'qq', kind: 'group', groupId: '333333', userId: '111111', mentioned: true, id: 'plain', text: '看图', at: Date.now() };
  const transport = { prepare: async () => {}, send: async result => sent.push(result) };
  await delivery(message, transport); await delivery(message, transport);
  assert.equal(calls, 1); assert.deepEqual(sent[0].bubbles, [output]); assert.equal(status.completed, 1);
  output = '另一条正文\n```harmonia\n{"facts":["完整记忆"]}\n```';
  await delivery({ ...message, id: 'metadata' }, transport);
  assert.deepEqual(sent[1].bubbles, ['另一条正文']);
  const memory = await readJson(path.join(root, 'memory/memories.json'));
  assert.equal(memory.facts[0].text, '完整记忆'); assert.equal(memory.facts[0].source.messageId, 'metadata');
  output = '正文\n```harmonia\n{"files":["E:/private/file"]}\n```';
  await assert.rejects(router({ ...message, userId: '444444', mentioned: false }), /Local attachments require owner/);
});
