import sharp from 'sharp';
import { collectSticker } from '../lib/stickers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { recentHistory, recentMessage, HISTORY_MAX_AGE_MS } from '../lib/history.mjs';
import { CACHE } from '../lib/config.mjs';
import { contextFor, writeJson, readJson } from '../lib/store.mjs';
import { resetReplaySurface, installHistoryWindow, splitBridgeMessage } from '../plugins/dsh-agent/history-window.mjs';
import { createDelivery } from '../lib/delivery.mjs';
import { createRouter } from '../brain/unified-router.mjs';
import { writeFile } from 'node:fs/promises';

const now = Date.parse('2026-11-05T12:00:00+08:00');
test('history drops 30 at the 50-message threshold, including the incoming message reservation', () => {
  const rows = n => Array.from({ length: n }, (_, id) => ({ id, at: now - (n - id) * 1000 }));
  assert.equal(recentHistory(rows(49), now, 0).length, 49);
  assert.equal(recentHistory(rows(49), now).length, 19);
  assert.equal(recentHistory(rows(50), now, 0).length, 20);
  assert.equal(recentHistory(rows(79), now, 0).length, 49);
  assert.equal(recentHistory(rows(80), now, 0).length, 20);
  assert.equal(recentHistory(rows(50), now, 0)[0].id, 30);
  assert.throws(() => recentHistory([], now, 50), /incoming/);
});

test('four elapsed days discard the earliest three days in one batch; invalid and future records stay out', () => {
  const day = 86400000, start = now - 4 * day;
  const rows = Array.from({ length: 5 }, (_, id) => ({ id, at: start + id * day }));
  assert.equal(recentHistory(rows.slice(0, 4), now - 1).length, 4);
  assert.deepEqual(recentHistory(rows, now).map(row => row.id), [3, 4]);
  assert.equal(rows.length, 5, 'Selection must not mutate the original history');
  const mixed = [{ id: 'unknown' }, { id: 'invalid', at: 'bad' }, { id: 'future', at: now + 1 }, ...rows];
  assert.deepEqual(recentHistory(mixed, now).map(row => row.id), [3, 4]);
  assert.deepEqual(recentHistory([{ at: now - 10 * day }, { at: now - 6 * day }, { at: now - 2 * day }], now), [{ at: now - 2 * day }]);
  assert.equal(recentMessage({ at: start }, now), false);
});

test('history between batch thresholds preserves its existing prefix as new records append', () => {
  const first = Array.from({ length: 20 }, (_, id) => ({ id, at: now - 100000 + id * 1000 }));
  const next = recentHistory([...first, { id: 'new', at: now }], now);
  assert.deepEqual(next.slice(0, first.length), first);
});

test('all chat scopes use the same window while memory documents remain intact', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'history-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { root, ownerQQ: '111111', ownerWechat: 'owner' };
  const rows = Array.from({ length: 130 }, (_, id) => ({ id, at: Date.now() - (130 - id) * 1000 }));
  rows.push({ id: 'expired', at: Date.now() - HISTORY_MAX_AGE_MS - 1000 });
  await writeJson(path.join(root, 'memory/memories.json'), { facts: ['LONG_TERM_DOCUMENT'] });
  for (const [scope, message] of [
    ['owner-private', { channel: 'qq', kind: 'private', userId: '111111' }],
    ['owner-private', { channel: 'wechat', kind: 'private', userId: 'owner' }],
    ['qq-group-333333', { channel: 'qq', kind: 'group', groupId: '333333' }],
    ['qq-private-6775657374', { channel: 'qq', kind: 'private', userId: 'guest' }],
  ]) {
    const file = path.join(root, 'runtime/sessions', scope + '.json'); await writeJson(file, rows);
    const selected = await contextFor(message, config);
    assert.equal(selected.history.length, 40); assert.equal(selected.history[0].id, 90);
    assert.equal((await readJson(file)).length, 131);
    assert.deepEqual(selected.memory.facts, ['LONG_TERM_DOCUMENT']);
  }
});
test('DSH replay clearing uses a native surface replacement, preserves raw records and does not cut an active tool step', async () => {
  const original = [{ seq: 0, type: 'system/message' }, { seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/message' }];
  const calls = [];
  const session = { surface: { nodes: [0, 1, 2] }, eventAt: seq => original[seq], append: (...args) => calls.push(args) };
  resetReplaySurface(session);
  assert.deepEqual(calls[0][2], { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] });
  assert.equal(original.length, 3); assert.equal(calls[0][1].source.kind, 'harmonia-history-window');
  let hook;
  installHistoryWindow({ on: (_name, fn) => { hook = fn; } }, { owner: false });
  await hook({ agent: { session }, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(calls.length, 1);
});
test('expired transport messages never download, review or call the brain', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'expired-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fail = () => { throw new Error('Expired input must not reach processing'); };
  const deliver = createDelivery({ root }, fail, {}, { review: fail });
  for (const kind of ['private', 'group']) await deliver({ channel: 'qq', kind, at: Date.now() - HISTORY_MAX_AGE_MS - 1000 }, { prepare: fail, send: fail });
  assert.equal(recentMessage({ at: 'invalid' }), false);
});

test('community proactive turns receive shared sticker meanings and leave memory to the system reference', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'proactive-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets/stickers'), { recursive: true });
  await writeJson(path.join(root, 'memory/memories.json'), { facts: ['一个值得留下的念头'], todos: [] });
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const file = path.join(root, 'meme.png'); await writeFile(file, image);
  await collectSticker({}, { root }, file, '开心庆祝');
  let hook;
  installHistoryWindow({ on: (_name, fn) => { hook = fn; } }, { owner: true, personaFile: path.join(root, 'config/PERSONA.md') });
  const session = { surface: { nodes: [] } };
  const message = { source: { kind: 'proactive' }, content: [{ type: 'text', text: '想聊天' }] };
  const result = await hook({ agent: { session }, step: 1 }, async () => ({ kind: 'enter', messages: [message] }));
  assert.doesNotMatch(JSON.stringify(result.messages), /一个值得留下的念头/);
  assert.match(JSON.stringify(result.messages), /开心庆祝/);
  assert.match(result.messages.at(-1).content.at(-1).text, /当前北京时间/);
  assert.doesNotMatch(JSON.stringify(result.messages), /harmonia-topic-research|本轮主动话题工作流/);
  assert.ok(result.messages.at(-1).content.some(block => block.text === '想聊天'));
});
test('each outgoing bubble counts as one dated chat record', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'bubbles-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets/stickers'), { recursive: true });
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'persona');
  const route = createRouter({ root, ownerQQ: '111111', brain: 'dsh' }, { brain: async () => ({
    reply: true, bubbles: ['first', 'second'], sticker: '', facts: [], todos: [], slang: [], impressions: [],
  }) });
  await route({ channel: 'qq', kind: 'private', userId: '111111', text: 'hello' });
  const rows = await readJson(path.join(root, 'runtime/sessions/owner-private.json'));
  assert.deepEqual(rows.map(row => row.text), ['hello', 'first', 'second']);
  assert.ok(rows.every(row => Number.isFinite(row.at)));
});

test('router batches count cleanup across the input and each generated bubble', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'batch-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets/stickers'), { recursive: true });
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'persona');
  const file = path.join(root, 'runtime/sessions/owner-private.json');
  await writeJson(file, Array.from({ length: 48 }, (_, id) => ({ id, text: `old-${id}`, at: Date.now() - (48 - id) * 1000 })));
  const route = createRouter({ root, ownerQQ: '111111', brain: 'dsh' }, { brain: async () => ({
    reply: true, bubbles: ['first', 'second'], sticker: '', facts: [], todos: [], slang: [], impressions: [],
  }) });
  await route({ channel: 'qq', kind: 'private', userId: '111111', text: 'current' });
  const saved = await readJson(file);
  assert.equal(saved.length, 21); assert.equal(saved[0].id, 30);
  assert.deepEqual(saved.slice(-3).map(row => row.text), ['current', 'first', 'second']);
});
