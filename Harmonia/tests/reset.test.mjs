import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { readJson, writeJson, contextFor } from '../lib/store.mjs';
import { isResetCommand, resetContext } from '../lib/reset.mjs';
import { createDelivery } from '../lib/delivery.mjs';
import { createRouter } from '../brain/unified-router.mjs';
import { normalizeQQ, shouldRespond } from '../adapters/qq.mjs';
import { normalizeWechat, runWechat } from '../adapters/wechat.mjs';
import { drainProactive } from '../lib/proactive-delivery.mjs';

const owner = { channel: 'qq', kind: 'private', userId: '111111', id: 'reset', text: '/reset', commandText: '/reset' };
const answer = { reply: true, bubbles: ['fresh'], sticker: '', facts: [], todos: [], slang: [], impressions: [] };
const fail = () => { throw new Error('Command must bypass model, review and media'); };
async function fixture(t) {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'reset-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'assets/stickers'), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'PERSONA-KEPT');
  await writeJson(path.join(root, 'memory/memories.json'), { version: 2, facts: [{ id: 'fact', text: 'MEMORY-KEPT' }], todos: [] });
  await writeJson(path.join(root, 'runtime/sessions/owner-private.json'), [{ text: 'OLD-HISTORY', at: Date.now() - 1000 }]);
  return { root, cache: root, env: {}, brain: 'dsh', ownerQQ: '111111', botQQ: '222222', ownerWechat: 'owner-wx',
    groups: ['333333'], qqUsers: ['555555'], wechatUsers: ['guest-wx'], aliases: [], probability: 0, cooldown: 90000, bubbleDelay: 0 };
}

test('/reset requires exact literal command text; quotes, transcripts, /new and arguments are ordinary inputs', () => {
  for (const commandText of ['/reset', ' /RESET\n']) assert.ok(isResetCommand({ commandText }));
  for (const commandText of ['', '/new', '/reset now', '请执行 /reset', '/reset\nhello']) assert.equal(isResetCommand({ text: '/reset', commandText }), false);
  assert.equal(isResetCommand({ text: '/reset' }), false);
  const voice = normalizeWechat({ message_type: 1, from_user_id: 'owner-wx', message_id: 1,
    item_list: [{ type: 3, voice_item: { text: '/reset' } }] });
  assert.equal(isResetCommand(voice), false);
  const quoted = normalizeQQ({ post_type: 'message', self_id: '222222', user_id: '111111', message_type: 'private', message_id: 1,
    message: [{ type: 'reply', data: { id: 2 } }] }, { botQQ: '222222', aliases: [] });
  quoted.text += '\n[引用内容：/reset]';
  assert.equal(isResetCommand(quoted), false);
});

test('owner reset shares QQ/WeChat scope, retains DSH mapping, memory, persona and other histories', async t => {
  const config = await fixture(t), stopped = [];
  const mapping = { 'owner-private': 'owner-session', 'qq-group-333333': 'group-session' };
  await writeJson(path.join(config.root, 'runtime/dsh-sessions.json'), mapping);
  await writeJson(path.join(config.root, 'runtime/sessions/qq-group-333333.json'), [{ text: 'GROUP-KEPT', at: Date.now() - 1000 }]);
  await resetContext({ ...owner, channel: 'wechat', userId: config.ownerWechat }, config, { stopSessionWork: async id => stopped.push(id) });
  assert.deepEqual(stopped, ['owner-session']);
  assert.deepEqual((await contextFor(owner, config)).history, []);
  assert.deepEqual(await readJson(path.join(config.root, 'runtime/dsh-sessions.json')), mapping);
  assert.match(JSON.stringify((await contextFor(owner, config)).memory), /MEMORY-KEPT/);
  assert.equal(await readFile(path.join(config.root, 'config/PERSONA.md'), 'utf8'), 'PERSONA-KEPT');
  assert.match(JSON.stringify(await readJson(path.join(config.root, 'runtime/sessions/qq-group-333333.json'))), /GROUP-KEPT/);
  assert.ok((await readJson(path.join(config.root, 'runtime/context-resets.json')))['owner-private']);
});

test('only direct owner group mention can reset shared history, cancelling both group privilege sessions', async t => {
  const config = await fixture(t), stopped = [];
  const message = { ...owner, kind: 'group', groupId: '333333', mentioned: true };
  const historyFile = path.join(config.root, 'runtime/sessions/qq-group-333333.json');
  await writeJson(historyFile, [{ text: 'GROUP-OLD', at: Date.now() - 1000 }]);
  await writeJson(path.join(config.root, 'runtime/dsh-sessions.json'), {
    'owner-private': 'private', 'qq-group-333333': 'public', 'qq-group-333333:owner-mention': 'owner-group',
  });
  for (const denied of [{ ...owner, userId: '555555' }, { ...message, userId: '555555' }, { ...message, mentioned: false }]) {
    assert.match((await resetContext(denied, config, { stopSessionWork: fail })).bubbles[0], /只有主人/);
  }
  assert.match(JSON.stringify(await readJson(historyFile)), /GROUP-OLD/);
  await resetContext(message, config, { stopSessionWork: async id => stopped.push(id) });
  assert.deepEqual(stopped.sort(), ['owner-group', 'public']);
  assert.deepEqual(await readJson(historyFile), []);
  assert.match(JSON.stringify((await contextFor(owner, config)).history), /OLD-HISTORY/);
  assert.equal(shouldRespond(message, config, Date.now(), fail), true);
});

test('reset bypasses model readiness/media/review, and duplicate commands never resend or cancel newer work', async t => {
  const config = await fixture(t), sent = [], status = { completed: 0, failed: 0 };
  const transport = { prepare: fail, afterReview: fail, send: async reply => sent.push(reply.bubbles[0]) };
  let resets = 0;
  const options = { review: fail, reset: async message => { resets++; return resetContext(message, config); } };
  await createDelivery(config, fail, status, options)(owner, transport);
  const began = Promise.withResolvers(), finish = Promise.withResolvers();
  let signal;
  const deliver = createDelivery(config, async (_message, options) => { signal = options.signal; began.resolve(); await finish.promise; return answer; }, status, options);
  const active = deliver({ ...owner, id: 'new-message', text: 'hello', commandText: 'hello' }, { ...transport, prepare: async () => {}, afterReview: undefined });
  await began.promise;
  const replay = deliver(owner, transport);
  finish.resolve(); await Promise.all([active, replay]);
  assert.equal(signal.aborted, false);
  assert.equal(resets, 1); assert.equal(sent.length, 2);
  const denied = { ...owner, id: 'guest-reset', userId: '555555' };
  await deliver(denied, transport);
  assert.match(sent.at(-1), /只有主人/); assert.equal(resets, 1);
});

test('reset cancels active/queued owner turns across platforms and prevents late history/memory writes', async t => {
  const config = await fixture(t), began = Promise.withResolvers(), cancelled = Promise.withResolvers(), finish = Promise.withResolvers();
  const prompts = [], sent = [], status = { completed: 0, failed: 0 };
  const router = createRouter(config, { brain: async input => {
    prompts.push(input.prompt);
    if (prompts.length === 1) {
      input.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      began.resolve(); await finish.promise;
      return { ...answer, facts: ['STALE-MEMORY'] };
    }
    return answer;
  } });
  const deliver = createDelivery(config, router, status);
  const transport = { prepare: async () => {}, send: async reply => sent.push(reply.bubbles[0]) };
  const old = deliver({ ...owner, id: 'old', text: 'old', commandText: 'old' }, transport);
  await began.promise;
  const queued = deliver({ ...owner, id: 'queued', text: 'queued', commandText: 'queued' }, transport);
  const reset = deliver({ ...owner, channel: 'wechat', userId: config.ownerWechat }, transport);
  await cancelled.promise; finish.resolve();
  await Promise.all([old, queued, reset]);
  assert.equal(prompts.length, 1); assert.equal(sent.length, 1);
  assert.deepEqual((await contextFor(owner, config)).history, []);
  assert.doesNotMatch(JSON.stringify((await contextFor(owner, config)).memory), /STALE-MEMORY/);
  const receipts = await readJson(path.join(config.root, 'runtime/receipts.json'));
  assert.equal(receipts['qq:private:111111:old'].state, 'cancelled');
  assert.equal(receipts['qq:private:111111:queued'].state, 'cancelled');
  await deliver({ ...owner, id: 'fresh', text: 'next', commandText: 'next' }, transport);
  assert.doesNotMatch(prompts.at(-1), /OLD-HISTORY|STALE-MEMORY/);
  assert.match(prompts.at(-1), /MEMORY-KEPT/);
});

test('failed DSH cancellation preserves history and reports failure once', async t => {
  const config = await fixture(t), stopped = [], sent = [], status = { completed: 0, failed: 0 };
  await writeJson(path.join(config.root, 'runtime/dsh-sessions.json'), { 'owner-private': 'broken-session' });
  const reset = message => resetContext(message, config, { stopSessionWork: async id => { stopped.push(id); throw new Error('offline'); } });
  const deliver = createDelivery(config, fail, status, { reset });
  const transport = { prepare: fail, send: async reply => sent.push(reply.bubbles[0]) };
  await deliver(owner, transport); await deliver(owner, transport);
  assert.deepEqual(stopped, ['broken-session']); assert.equal(sent.length, 1);
  assert.match(sent[0], /重置未完成/);
  assert.match(JSON.stringify((await contextFor(owner, config)).history), /OLD-HISTORY/);
  await writeJson(path.join(config.root, 'runtime/dsh-sessions.json'), { 'qq-group-333333': 'broken', 'qq-group-333333:owner-mention': 'also-stop' });
  const attempted = [];
  await assert.rejects(resetContext({ ...owner, kind: 'group', groupId: '333333', mentioned: true }, config, {
    stopSessionWork: async id => { attempted.push(id); if (id === 'broken') throw new Error('offline'); },
  }), /offline/);
  assert.deepEqual(attempted.sort(), ['also-stop', 'broken']);
});

test('authorized reset can drain a full queue while leaving an unrelated active group untouched', async t => {
  const config = await fixture(t), began = Promise.withResolvers(), finish = Promise.withResolvers();
  let groupSignal, brains = 0;
  const deliver = createDelivery(config, async (_message, { signal }) => {
    brains++; groupSignal = signal; began.resolve(); await finish.promise; return answer;
  }, { completed: 0, failed: 0 });
  const transport = { prepare: async () => {}, send: async () => {} };
  const groupTask = deliver({ ...owner, kind: 'group', groupId: '333333', id: 'group', text: 'hello', commandText: 'hello', mentioned: true }, transport);
  await began.promise;
  const queued = Array.from({ length: 49 }, (_x, id) => deliver({ ...owner, id: `queued-${id}`, text: 'old', commandText: 'old' }, transport));
  const reset = deliver(owner, transport);
  assert.equal(groupSignal.aborted, false);
  finish.resolve(); await Promise.all([groupTask, ...queued, reset]);
  assert.equal(brains, 1);
  assert.deepEqual((await contextFor(owner, config)).history, []);
});

test('reset invalidates old proactive candidates without consuming quota', async t => {
  const config = await fixture(t), now = Date.parse('2026-11-06T12:00:00+08:00');
  const file = path.join(config.root, 'runtime/proactive-outbox/old.json');
  await writeJson(file, { kind: 'alive', createdAt: now - 1000, bubbles: ['STALE'], sources: [] });
  await writeJson(path.join(config.root, 'runtime/context-resets.json'), { 'owner-private': now });
  await drainProactive(config, { qq: fail }, now + 1);
  assert.equal((await readJson(file)).state, 'cancelled-context-reset');
  assert.equal(await readJson(path.join(config.root, 'runtime/proactive-delivery.json'), null), null);
});

test('WeChat continues polling for reset while inference is running and commits cursors after delivery', async t => {
  const config = await fixture(t), abort = new AbortController(), began = Promise.withResolvers(), sent = [];
  await writeJson(path.join(config.root, 'runtime/wechat-auth.json'), { token: 'fixture', baseUrl: 'https://ilinkai.weixin.qq.com' });
  let polls = 0;
  const deliver = createDelivery(config, async (_message, { signal }) => {
    began.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  }, { completed: 0, failed: 0 });
  const fake = { notifyStart: async () => {}, notifyStop: async () => {}, getUpdates: async () => {
    if (polls++) await began.promise;
    if (polls > 2) { await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true })); return { ret: 0, msgs: [], get_updates_buf: 'end' }; }
    return { ret: 0, get_updates_buf: `cursor-${polls}`, msgs: [{ message_type: 1, from_user_id: 'owner-wx', message_id: polls,
      context_token: 'context', item_list: [{ type: 1, text_item: { text: polls === 1 ? 'slow turn' : '/reset' } }] }] };
  }, sendMessage: async reply => { sent.push(reply.text); abort.abort(); } };
  await runWechat(config, deliver, {}, abort.signal, () => fake);
  assert.equal(sent.length, 1); assert.match(sent[0], /已清空/);
  assert.equal((await readJson(path.join(config.root, 'runtime/wechat-cursor.json'))).buf, 'cursor-2');
});
