import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { evidenceUrls, verifiedCandidate } from '../lib/proactive-policy.mjs';
import { drainProactive } from '../lib/proactive-delivery.mjs';
import { writeJson, readJson } from '../lib/store.mjs';
import { shouldRespond } from '../adapters/qq.mjs';

test('group throttle applies to named replies and probabilistic idle replies', () => {
  const now = 1000000, c = { probability: .05, cooldown: 90000, directCooldown: 8000 };
  assert.equal(shouldRespond({ kind: 'group', direct: true }, c, now - 1000, () => 0, now), false);
  assert.equal(shouldRespond({ kind: 'group', direct: true }, c, now - 9000, () => 1, now), true);
  assert.equal(shouldRespond({ kind: 'group', direct: false }, c, now - 10000, () => 0, now), false);
  assert.equal(shouldRespond({ kind: 'group', direct: false }, c, now - 100000, () => .04, now), true);
});
test('group candidates use 5% for guests and 20% for owner; direct mentions bypass probability and cooldown', () => {
  const now = 1000000, config = { ownerQQ: '111111', probability: .05, cooldown: 90000, directCooldown: 8000 };
  const guest = { channel: 'qq', kind: 'group', userId: '222222', direct: false };
  const owner = { ...guest, userId: config.ownerQQ };
  for (const [message, probability] of [[guest, .05], [owner, .2]]) {
    assert.equal(shouldRespond(message, config, 0, () => probability - .001, now), true);
    assert.equal(shouldRespond(message, config, 0, () => probability, now), false);
    assert.equal(shouldRespond(message, config, now - 1000, () => 0, now), false);
    assert.equal(shouldRespond({ ...message, direct: true, mentioned: true }, config, now, () => { throw new Error('Mention must not roll probability'); }, now), true);
  }
});
test('delivery leaves cadence and quota to dsh-alive and accepts unsourced care', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'alive-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-11-06T23:00:00+08:00');
  const previous = { day: '2026-11-06', count: 99, lastSent: now, urls: [] };
  await writeJson(path.join(root, 'runtime/proactive-delivery.json'), previous);
  await writeJson(path.join(root, 'runtime/owner-activity.json'), { at: now, channel: 'qq' });
  await writeJson(path.join(root, 'runtime/proactive-outbox/care.json'), { kind: 'alive', createdAt: now, bubbles: ['想和你聊聊'], sources: [] });
  let calls = 0;
  assert.equal((await drainProactive({ root }, { qq: async () => calls++ }, now)).sent, true);
  assert.equal(calls, 1);
  assert.deepEqual(await readJson(path.join(root, 'runtime/proactive-delivery.json')), previous);
});
test('private file URLs and failed searches do not count as fresh search evidence', () => {
  const call = (id, name, action) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name, arguments: JSON.stringify({ action }) }] } } });
  const result = (id, text, isError = false) => ({ type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text }] } } });
  const e = evidenceUrls([call('1', 'read'), result('1', 'https://private.example/'), call('2', 'web_call', 'search.run'), result('2', 'https://failed.example/', true), call('3', 'web_search'), result('3', '- [source](https://example.com/news)')]);
  assert.deepEqual([...e.urls], ['https://example.com/news']);
  const v = { reply: true, bubbles: ['看到了一个细节'], sources: [{ url: 'https://example.com/news' }] };
  assert.ok(verifiedCandidate(v, e));
  assert.equal(verifiedCandidate({ ...v, sources: [{ url: 'https://invented.example/' }] }, e), null);
  assert.equal(verifiedCandidate(v, e, ['https://example.com/news']), null);
});
test('delivery reserves once across platforms and never retries an uncertain send', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'proactive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-10-31T12:00:00+08:00');
  const file = path.join(root, 'runtime/proactive-outbox/test.json');
  await writeJson(file, { id: 'test', createdAt: now, bubbles: ['有个新发现'], sources: [{ url: 'https://example.com' }] });
  let calls = 0;
  await drainProactive({ root }, { qq: async () => { calls++; throw new Error('uncertain'); }, wechat: async () => { calls++; } }, now);
  await drainProactive({ root }, { qq: async () => { calls++; } }, now + 3 * 3600000);
  assert.equal(calls, 1); assert.equal((await readJson(file)).state, 'failed-or-uncertain');
});

test('urgency candidates retain ordinary uncertain-send protection and are cancelled if the owner returns or mutes', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'continuation-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-11-07T12:00:00+08:00'), file = path.join(root, 'runtime/proactive-outbox/urgent.json');
  const alive = { ok: true, continuationAllowed: true, tsundere: { active: true, urgencyId: 'urgent-id', expiresAt: now + 1800000 } };
  const config = { root, dshUrl: 'http://live-plugin', token: 'fixture-token' };
  const request = async (url, options) => {
    assert.equal(url, 'http://live-plugin/harmonia/alive-chat'); assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return { ok: true, json: async () => alive };
  };
  const reset = async () => {
    await writeJson(file, { id: 'urgent', kind: 'alive', continuationId: 'urgent-id', createdAt: now, bubbles: ['其实是想让你陪我'], sources: [] });
  };
  let calls = 0;
  await reset(); assert.equal((await drainProactive(config, { qq: async () => calls++ }, now, request)).sent, true);
  assert.equal(calls, 1);
  for (const change of [() => { alive.tsundere.urgencyId = null; }, () => { alive.tsundere.urgencyId = 'urgent-id'; alive.continuationAllowed = false; }]) {
    change(); await reset(); await drainProactive(config, { qq: async () => calls++ }, now, request);
    assert.equal((await readJson(file)).state, 'cancelled-continuation');
  }
  assert.equal(calls, 1);
  alive.continuationAllowed = true; await reset();
  await drainProactive(config, { qq: async () => { calls++; throw new Error('uncertain'); } }, now, request);
  await drainProactive(config, { qq: async () => calls++ }, now + 1000, request);
  assert.equal(calls, 2); assert.equal((await readJson(file)).state, 'failed-or-uncertain');
  await reset();
  await drainProactive(config, { qq: async () => calls++ }, now, async () => { throw new Error('plugin offline'); });
  assert.equal(calls, 2); assert.equal((await readJson(file)).state, 'cancelled-continuation');
});
