import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { CACHE } from '../lib/config.mjs';
import { writeJson } from '../lib/store.mjs';
import { qqActionRequest, executeQQAction } from '../lib/qq-actions.mjs';
import { createQQ } from '../adapters/qq.mjs';

test('a confirmed share card is counted once as an owner chat output', async t => {
  const config = await fixture(t), events = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    events.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  Object.assign(config, { brain: 'dsh', dshUrl: `http://127.0.0.1:${server.address().port}` });
  const request = { sessionId: 'owner-session', requestId: 'share-once', tool: 'qq_share', args: { title: 'card', jump_url: 'https://example.com' } };
  let calls = 0;
  const call = async () => { calls++; return { message_id: 42 }; };
  await executeQQAction(request, config, call); await executeQQAction(request, config, call);
  assert.equal(calls, 1); assert.equal(events.length, 1); assert.equal(events[0].type, 'sent'); assert.match(events[0].text, /card/);
});

async function fixture(t) {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'qq-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'runtime/dsh-sessions.json'), { 'owner-private': 'owner-session', 'qq-group-333333:owner-mention': 'owner-mention' });
  return { root, ownerQQ: '111111', botQQ: '222222', token: 'x'.repeat(64), port: 0 };
}

test('QQ action boundary pins effects to the owner and exposes only read-only Qzone actions', () => {
  const config = { ownerQQ: '111111', botQQ: '222222' };
  assert.deepEqual(qqActionRequest('qq_poke', { user_id: 999999, group_id: 333333 }, config).params, { user_id: 111111 });
  assert.deepEqual(qqActionRequest('qq_qzone', { action: 'list' }, config).params, { target_uin: 111111, pos: 0, num: 10 });
  assert.equal(qqActionRequest('qq_qzone', { action: 'detail', tid: 'real-tid', uin: 'me' }, config).params.target_uin, 222222);
  assert.equal(qqActionRequest('qq_qzone', { action: 'feeds' }, config).action, 'get_qzone_feeds');
  for (const action of ['post', 'like', 'comment', 'delete']) assert.throws(() => qqActionRequest('qq_qzone', { action }, config));
  assert.throws(() => qqActionRequest('qq_qzone', { action: 'list', num: 101 }, config));
  assert.throws(() => qqActionRequest('qq_share', { title: 'x', jump_url: 'file:///secret' }, config));
  assert.equal(qqActionRequest('qq_share', { title: 'x', jump_url: 'https://example.com', user_id: 999999 }, config).params.user_id, 111111);
});

test('QQ effects are never replayed after success, uncertain send or a foreign session', async t => {
  const config = await fixture(t); let calls = 0;
  const request = { sessionId: 'owner-session', requestId: 'call-1', tool: 'qq_poke', args: {} };
  const success = async () => { calls++; return null; };
  assert.equal((await executeQQAction(request, config, success)).ok, true);
  assert.equal((await executeQQAction(request, config, success)).ok, true);
  const uncertain = { ...request, requestId: 'call-2' };
  assert.equal((await executeQQAction(uncertain, config, async () => { calls++; throw new Error('timeout'); })).ok, false);
  assert.equal((await executeQQAction(uncertain, config, success)).ok, false);
  await assert.rejects(executeQQAction({ ...request, sessionId: 'group-session' }, config, success), /owner session/);
  assert.equal((await executeQQAction({ ...request, sessionId: 'owner-mention', tool: 'qq_qzone', args: { action: 'list' } }, config, async () => null)).ok, true);
  assert.equal(calls, 2);
});

test('authenticated local QQ tool endpoint reuses the existing OneBot socket', async t => {
  const config = await fixture(t), calls = [];
  const qq = createQQ(config, () => {}); t.after(() => qq.close());
  const address = await qq.start();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${config.token}`, 'X-Self-ID': config.botQQ } });
  t.after(() => socket.terminate()); await once(socket, 'open');
  socket.on('message', bytes => {
    const request = JSON.parse(bytes); calls.push(request);
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: null }));
  });
  const endpoint = `http://127.0.0.1:${address.port}/harmonia/qq-action`;
  const request = { sessionId: 'owner-session', requestId: 'local-test', tool: 'qq_share', args: { title: '测试', jump_url: 'https://example.com' } };
  assert.equal((await fetch(endpoint, { method: 'POST', body: JSON.stringify(request) })).status, 403);
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: JSON.stringify(request) });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'send_tuwen_ark');
  assert.equal(calls[0].params.user_id, 111111); assert.equal(calls[0].params.group_id, undefined);
});
