import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { followTurn, checkTurnResult, DshTurnError } from '../brain/dsh.mjs';
import { createDelivery } from '../lib/delivery.mjs';
import { readJson } from '../lib/store.mjs';
import { CACHE } from '../lib/config.mjs';

async function connection(t, handler) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  server.on('connection', socket => socket.once('message', bytes => {
    const open = JSON.parse(bytes);
    assert.equal(open.payload.args.request.assistantStream, true);
    const send = value => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value })); };
    send({ type: 'snapshot', records: [] });
    handler(send, socket);
  }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture', ensureAuth: async () => {} };
}
const start = { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } };
const end = reason => ({ type: 'event', event: { type: 'turn/end', data: { turn: 1, reason } } });

test('live progress allows inference longer than the no-progress budget and returns final output once', async t => {
  let submits = 0;
  const client = await connection(t, (send, socket) => {
    send(start);
    let ticks = 0;
    const timer = setInterval(() => {
      send({ type: 'assistant-stream', frame: { type: 'chunk', text: 'progress' } });
      if (++ticks === 6) {
        clearInterval(timer);
        send({ type: 'event', event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"reply":true}' }] } } } });
        send(end({ kind: 'completed' }));
      }
    }, 50);
    socket.once('close', () => clearInterval(timer));
  });
  const began = Date.now();
  assert.equal(await followTurn(client, 'test', async () => { submits++; }, AbortSignal.timeout(2000), { idleMs: 200 }), '{"reply":true}');
  assert.ok(Date.now() - began >= 250); assert.equal(submits, 1);
});
test('silent provider hits idle deadline with a distinct safe error code', async t => {
  const client = await connection(t, send => send(start));
  await assert.rejects(followTurn(client, 'test', async () => {}, AbortSignal.timeout(2000), { idleMs: 50 }), { code: 'DSH_IDLE_TIMEOUT' });
});
test('whole-turn deadline still stops an endlessly streaming turn', async t => {
  const client = await connection(t, (send, socket) => {
    send(start);
    const timer = setInterval(() => send({ type: 'assistant-stream', frame: { text: 'progress' } }), 15);
    socket.once('close', () => clearInterval(timer));
  });
  await assert.rejects(followTurn(client, 'test', async () => {}, AbortSignal.timeout(160), { idleMs: 1000 }), { code: 'DSH_TURN_TIMEOUT' });
});
test('terminal busy response is reported accurately and is not retried or treated as success', async t => {
  let submits = 0;
  const client = await connection(t, send => {
    send(start); send(end({ kind: 'error', error: { message: 'server_busy: Our servers are currently busy.' } }));
  });
  await assert.rejects(followTurn(client, 'test', async () => { submits++; }, AbortSignal.timeout(2000)), { code: 'DSH_BUSY' });
  assert.equal(submits, 1);
  assert.throws(() => checkTurnResult({ kind: 'error', error: { message: 'private endpoint failure' } }, 'partial text'), { code: 'DSH_UPSTREAM_ERROR' });
});
test('private timeout sends one failure notice, keeps failed state, and does not replay tools on duplicate receipt', async t => {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'timeout-notice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const message = { channel: 'qq', kind: 'private', userId: 'owner', id: '123' };
  let attempts = 0; const sent = [], status = { completed: 0, failed: 0 };
  const route = async () => { attempts++; throw new DshTurnError('DSH_IDLE_TIMEOUT', 'hidden diagnostic'); };
  const transport = { prepare: async () => {}, send: async response => sent.push(response.bubbles.join('')) };
  await createDelivery({ root }, route, status)(message, transport);
  await createDelivery({ root }, route, status)(message, transport);
  assert.equal(attempts, 1); assert.equal(sent.length, 1); assert.match(sent[0], /超时/);
  assert.doesNotMatch(sent[0], /hidden diagnostic/);
  const receipt = (await readJson(path.join(root, 'runtime/receipts.json')))['qq:private:owner:123'];
  assert.equal(receipt.errorCode, 'DSH_IDLE_TIMEOUT'); assert.equal(receipt.failureNotice, 'sent');
  assert.equal(receipt.state, 'failed-or-uncertain');
});
