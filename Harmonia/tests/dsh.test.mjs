import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { parseDshReply, runDsh } from '../brain/dsh.mjs';

test('DSH keeps legacy JSON compatibility and rejects mixed internal fields', () => {
  assert.deepEqual(parseDshReply('```json\n{"reply":false}\n```'), { reply: false });
  assert.throws(() => parseDshReply('some text before {"reply":true}'));
});
test('DSH persistent scope mapping shares owner platforms but separates public sessions', async t => {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'dsh-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; let count = 0;
  const response = { reply: true, bubbles: ['OK'], sticker: '', facts: [], todos: [], slang: [], impressions: [] };
  const client = { async callUnary(name, data) {
    calls.push({ name, data });
    let value = {};
    if (name === 'session/modelCatalog') value = { default: { provider: 'test', model: 'test-model' }, groups: [{ id: 'test', models: [{ id: 'test-model' }] }] };
    if (name === 'session/create') value = { sessionId: `session-${++count}` };
    return { result: { ok: true, value } };
  } };
  const config = { root, timeout: 5000 };
  const execute = async (_client, _session, submit) => { await submit(); return JSON.stringify(response); };
  for (const scope of ['owner-private', 'owner-private', 'qq-group-123']) assert.deepEqual(await runDsh({ prompt: 'test', scope }, config, client, execute), response);
  assert.deepEqual(calls.filter(c => c.name === 'session/create').map(c => c.data.agentPreset), ['harmonia-owner', 'harmonia-public']);
  assert.deepEqual(calls.filter(c => c.name === 'session/prompt').map(c => c.data.sessionId), ['session-1', 'session-1', 'session-2']);
  await runDsh({ prompt: 'owner group mention', scope: 'qq-group-123', owner: true }, config, client, execute);
  await runDsh({ prompt: 'ordinary group message', scope: 'qq-group-123', owner: false }, config, client, execute);
  assert.deepEqual(calls.filter(c => c.name === 'session/create').map(c => c.data.agentPreset), ['harmonia-owner', 'harmonia-public', 'harmonia-owner']);
  assert.deepEqual(calls.filter(c => c.name === 'session/prompt').slice(-2).map(c => c.data.sessionId), ['session-3', 'session-2']);
  for (const call of calls.filter(c => c.name === 'session/prompt').slice(0, 3)) {
    assert.equal(call.data.content[0].text, 'test');
    assert.match(call.data.content.at(-1).text, /当前北京时间.*Asia\/Shanghai/);
  }
  const image = path.join(root, 'image.png'); await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await runDsh({ prompt: 'image turn', images: [image], scope: 'owner-private' }, config, client, execute);
  const imageTurn = calls.filter(c => c.name === 'session/prompt').at(-1).data.content;
  assert.deepEqual(imageTurn.map(block => block.type), ['text', 'image', 'text']);
  assert.match(imageTurn.at(-1).text, /当前北京时间/);
  await assert.rejects(runDsh({ prompt: 'test', scope: 'owner-private' }, config, client, async () => { throw new Error('busy'); }), /busy/);
  assert.equal(calls.filter(c => c.name === 'session/cancel').length, 0, 'Do not cancel an existing UI turn when our prompt was never submitted');
});
test('DSH without a configured model never submits a message', async () => {
  const client = { async callUnary(name) { assert.equal(name, 'session/modelCatalog'); return { result: { ok: true, value: { default: {}, groups: [] } } }; } };
  await assert.rejects(runDsh({ prompt: 'private', scope: 'owner-private' }, { timeout: 5000 }, client), /默认模型/);
});

test('external reset cancellation reaches an active DSH turn and cancels the submitted session', async t => {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'dsh-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(), began = Promise.withResolvers(), calls = [];
  const client = { async callUnary(name) {
    calls.push(name);
    const value = name === 'session/modelCatalog' ? { default: { provider: 'test', model: 'test' }, groups: [{ id: 'test', models: [{ id: 'test' }] }] }
      : name === 'session/create' ? { sessionId: 'cancel-me' } : {};
    return { result: { ok: true, value } };
  } };
  const task = runDsh({ prompt: 'slow', scope: 'owner-private', signal: controller.signal }, { root, timeout: 5000 }, client,
    async (_client, _session, submit, signal) => {
      await submit(); began.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
  const rejected = assert.rejects(task, { name: 'AbortError' });
  await began.promise; controller.abort(); await rejected;
  assert.equal(calls.filter(name => name === 'session/prompt').length, 1);
  assert.equal(calls.filter(name => name === 'session/cancel').length, 1);
});
