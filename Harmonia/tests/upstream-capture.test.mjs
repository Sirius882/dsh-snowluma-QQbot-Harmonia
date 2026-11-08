import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { startUpstreamCapture } from '../lib/upstream-capture.mjs';

const cache = new URL('../../.cache/upstream-capture-tests/', import.meta.url);

test('captures final bytes, headers, concurrent attempts, gzip, errors and aborts without altering fetch', async () => {
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(new URL('run-', cache));
  const capture = startUpstreamCapture(directory);
  const received = new Map();
  const sse = 'event: delta\r\ndata: {"text":"中文🙂","tool_calls":[{"name":"read"}]}\r\n\r\ndata: [DONE]\n\n';
  const compressed = gzipSync(sse);
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    received.set(req.url, Buffer.concat(chunks));
    if (req.url === '/abort') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n'); return;
    }
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      res.write(compressed.subarray(0, 11)); await delay(10); res.end(compressed.subarray(11)); return;
    }
    res.writeHead(req.url === '/retry' ? 429 : 200,
      { 'content-type': 'text/event-stream', 'x-request-id': req.url, trailer: 'x-complete' });
    res.write(sse.slice(0, 20)); await delay(10); res.write(sse.slice(20));
    res.addTrailers({ 'x-complete': 'yes' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'user-agent': 'deepseek-harness/0.2.1-rc.5', authorization: 'Bearer local-fixture', 'content-type': 'application/json' };
  const body = '{ "model": "fixture", "messages":[{"role":"user","content":"原始空格🙂"}], "image":"data:image/png;base64,AA==", "tools":[{"name":"read"}] }\n';
  try {
    await fetch(`${base}/ignored`).then(res => res.text());
    await Promise.all(['/responses', '/chat/completions', '/retry', '/gzip'].map(async endpoint => {
      const response = await fetch(base + endpoint, { method: 'POST', headers, body });
      assert.equal(await response.text(), sse);
    }));
    const controller = new AbortController();
    const response = await fetch(`${base}/abort`, { method: 'POST', headers, body, signal: controller.signal });
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: partial\n\n');
    controller.abort(); await assert.rejects(reader.read());
    // A closed local port verifies an attempt that never receives HTTP headers.
    const closed = http.createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = closed.address().port; await new Promise(resolve => closed.close(resolve));
    await assert.rejects(fetch(`http://127.0.0.1:${closedPort}/responses`, { method: 'POST', headers, body }));
    await delay(30); await capture.flush();
    const day = (await readdir(directory)).find(name => /^\d{4}-/.test(name));
    const entries = await Promise.all((await readdir(`${directory}/${day}`)).map(async name => {
      const dir = `${directory}/${day}/${name}`;
      return { dir, meta: JSON.parse(await readFile(`${dir}/meta.json`, 'utf8')) };
    }));
    assert.equal(entries.length, 6);
    for (const entry of entries) {
      assert.equal(entry.meta.captureErrors, undefined);
      assert.equal(entry.meta.request.headers.find(([key]) => key === 'authorization')[1], 'Bearer local-fixture');
      assert.equal(await readFile(`${entry.dir}/request.prepared.raw`, 'utf8'), body);
      if (!entry.meta.response) {
        assert.equal(entry.meta.outcome, 'error'); assert.ok(entry.meta.error.code); continue;
      }
      const endpoint = new URL(entry.meta.request.url).pathname;
      assert.deepEqual(await readFile(`${entry.dir}/request.body.raw`), received.get(endpoint));
      assert.equal(entry.meta.requestBytes, Buffer.byteLength(body));
      assert.equal(entry.meta.requestBodyComplete, true);
      assert.match(await readFile(`${entry.dir}/request.headers.raw`, 'utf8'), /Bearer local-fixture/);
      assert.deepEqual(await readFile(`${entry.dir}/response.body.raw`), endpoint === '/gzip' ? compressed : Buffer.from(endpoint === '/abort' ? 'data: partial\n\n' : sse));
      if (endpoint === '/abort') { assert.equal(entry.meta.outcome, 'error'); continue; }
      assert.equal(entry.meta.outcome, 'completed');
      assert.equal(entry.meta.response.statusCode, endpoint === '/retry' ? 429 : 200);
      assert.equal(await readFile(`${entry.dir}/response.body.txt`, 'utf8'), sse);
      assert.equal(entry.meta.decodeError, undefined);
      if (endpoint !== '/gzip') assert.deepEqual(entry.meta.trailers, [['x-complete', 'yes']]);
      const events = (await readFile(`${entry.dir}/events.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(events.some(event => event.type === 'bodyChunkReceived'));
    }
    assert.equal(JSON.parse(await readFile(`${directory}/capture-status.json`, 'utf8')).errors, 0);
  } finally {
    await capture.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a capture filesystem failure leaves the model request and response working', async () => {
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(new URL('failure-', cache));
  const originalFetch = globalThis.fetch;
  const capture = startUpstreamCapture(directory);
  await writeFile(`${directory}/${new Date().toISOString().slice(0, 10)}`, 'blocks the day directory');
  const server = http.createServer(async (req, res) => {
    for await (const bytes of req) {} res.end('still works');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/responses`,
      { method: 'POST', headers: { 'user-agent': 'deepseek-harness/test' }, body: '{"fixture":true}' });
    assert.equal(await response.text(), 'still works');
    const status = JSON.parse(await readFile(`${directory}/capture-status.json`, 'utf8'));
    assert.equal(status.errors, 1); assert.ok(status.lastErrorCode);
  } finally {
    await capture.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(globalThis.fetch, originalFetch);
});
