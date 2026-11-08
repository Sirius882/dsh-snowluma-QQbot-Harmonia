import { channel } from 'node:diagnostics_channel';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function headerPairs(headers) {
  if (!Array.isArray(headers)) return Object.entries(headers || {});
  const pairs = [];
  for (let i = 0; i < headers.length; i += 2) pairs.push([String(headers[i]), String(headers[i + 1])]);
  return pairs;
}

// Observe the transport after SDK serialization; never consume or replace its streams.
export function startUpstreamCapture(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, '.gitignore'), '*\n');
  const requests = new WeakMap(), active = new Set(), pending = new Set(), subscriptions = [];
  const status = { pid: process.pid, startedAt: new Date().toISOString(), node: process.version,
    undici: process.versions.undici, directory, selector: 'user-agent contains deepseek-harness/', errors: 0 };
  const statusFile = path.join(directory, 'capture-status.json');
  writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n');
  const prepared = new AsyncLocalStorage(), originalFetch = globalThis.fetch;
  // Keep SDK JSON even when DNS/TLS fails before the first body byte is sent.
  const observedFetch = function(input, init) {
    const body = init?.body;
    const bytes = typeof body === 'string' ? Buffer.from(body)
      : ArrayBuffer.isView(body) ? Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      : body instanceof ArrayBuffer ? Buffer.from(body) : undefined;
    return prepared.run(bytes, () => originalFetch.call(this, input, init));
  };
  globalThis.fetch = observedFetch;
  function failed(error, state) {
    status.errors++;
    status.lastErrorAt = new Date().toISOString();
    status.lastErrorCode = error.code || error.name;
    if (state) (state.meta.captureErrors ??= []).push({ at: status.lastErrorAt, code: status.lastErrorCode });
    try { writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n'); } catch {}
    process.stderr.write(`[upstream-capture] Capture write failed (${status.lastErrorCode}); inspect capture-status.json.\n`);
  }
  const save = state => writeFileSync(path.join(state.dir, 'meta.json'), JSON.stringify(state.meta, null, 2) + '\n');
  const event = (state, type, data = {}) => state.events.write(JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
  function stream(state, file) {
    const output = createWriteStream(path.join(state.dir, file), { flags: 'wx' });
    output.on('error', error => failed(error, state));
    return output;
  }
  async function finish(state, outcome, error) {
    if (state.finishing) return;
    state.finishing = true;
    active.delete(state);
    state.meta.outcome = outcome;
    state.meta.endedAt = new Date().toISOString();
    if (error) state.meta.error = { name: error.name, code: error.code, message: error.message,
      cause: error.cause ? { code: error.cause.code, message: error.cause.message } : undefined };
    event(state, outcome, { error: state.meta.error });
    await Promise.all([state.sent, state.received, state.events].map(output => new Promise(resolve => {
      if (output.closed) return resolve();
      output.once('close', resolve);
      output.end();
    })));
    try {
      if (state.meta.response) {
        const encoding = state.meta.response.headers.find(([key]) => key.toLowerCase() === 'content-encoding')?.[1] || '';
        const decoders = encoding.toLowerCase().split(',').map(x => x.trim()).filter(x => x && x !== 'identity').reverse();
        const transforms = decoders.map(value => {
          if (value === 'gzip' || value === 'x-gzip') return createGunzip();
          if (value === 'deflate') return createInflate();
          if (value === 'br') return createBrotliDecompress();
          throw new Error(`Unsupported content encoding: ${value}`);
        });
        if (transforms.length) await pipeline(createReadStream(path.join(state.dir, 'response.body.raw')), ...transforms,
          createWriteStream(path.join(state.dir, 'response.body.txt')));
        else await copyFile(path.join(state.dir, 'response.body.raw'), path.join(state.dir, 'response.body.txt'));
      }
    } catch (decodeError) { state.meta.decodeError = { code: decodeError.code, message: decodeError.message }; }
    save(state);
  }
  function settle(state, outcome, error) {
    const task = finish(state, outcome, error).catch(e => failed(e, state));
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  function subscribe(name, callback) {
    const target = channel(`undici:${name}`);
    const listener = message => {
      try { callback(message); } catch (error) { failed(error, requests.get(message.request)); }
    };
    target.subscribe(listener);
    subscriptions.push(() => target.unsubscribe(listener));
  }
  subscribe('request:create', ({ request }) => {
    const headers = headerPairs(request.headers);
    if (!headers.some(([key, value]) => key.toLowerCase() === 'user-agent' && value.includes('deepseek-harness/'))) return;
    const now = new Date().toISOString();
    const dir = path.join(directory, now.slice(0, 10), `${now.replaceAll(':', '-')}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const state = { dir, meta: { startedAt: now, outcome: 'in-flight', pid: process.pid,
      request: { method: request.method, url: new URL(request.path, request.origin).href, headers },
      requestBytes: 0, responseBytes: 0, requestBodyComplete: false } };
    const body = prepared.getStore();
    if (body !== undefined) {
      writeFileSync(path.join(dir, 'request.prepared.raw'), body);
      state.meta.preparedBodyBytes = body.length;
    }
    state.sent = stream(state, 'request.body.raw');
    state.received = stream(state, 'response.body.raw');
    state.events = stream(state, 'events.jsonl');
    requests.set(request, state); active.add(state);
    save(state); event(state, 'created');
  });
  subscribe('client:sendHeaders', ({ request, headers, socket }) => {
    const state = requests.get(request); if (!state || state.finishing) return;
    writeFileSync(path.join(state.dir, 'request.headers.raw'), headers, 'latin1');
    state.meta.connection = { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort,
      alpnProtocol: socket.alpnProtocol || undefined, encrypted: !!socket.encrypted };
    event(state, 'headers-sent');
  });
  for (const [name, output, counter] of [['bodyChunkSent', 'sent', 'requestBytes'], ['bodyChunkReceived', 'received', 'responseBytes']]) {
    subscribe(`request:${name}`, ({ request, chunk }) => {
      const state = requests.get(request); if (!state || state.finishing) return;
      const bytes = Buffer.from(chunk);
      state[output].write(bytes);
      event(state, name, { offset: state.meta[counter], bytes: bytes.length });
      state.meta[counter] += bytes.length;
    });
  }
  subscribe('request:bodySent', ({ request }) => {
    const state = requests.get(request); if (!state || state.finishing) return;
    state.meta.requestBodyComplete = true; event(state, 'request-complete'); save(state);
  });
  subscribe('request:headers', ({ request, response }) => {
    const state = requests.get(request); if (!state || state.finishing) return;
    const received = { at: new Date().toISOString(), statusCode: response.statusCode,
      statusText: response.statusText, headers: headerPairs(response.headers) };
    event(state, 'response-headers', received);
    if (response.statusCode < 200) return;
    state.meta.response = received;
    writeFileSync(path.join(state.dir, 'response.headers.json'), JSON.stringify(received, null, 2) + '\n');
    save(state);
  });
  subscribe('request:trailers', ({ request, trailers }) => {
    const state = requests.get(request); if (!state || state.finishing) return;
    state.meta.trailers = headerPairs(trailers); settle(state, 'completed');
  });
  subscribe('request:error', ({ request, error }) => {
    const state = requests.get(request); if (state && !state.finishing) settle(state, 'error', error);
  });
  return {
    async flush() { await Promise.all([...pending]); },
    async stop() {
      if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
      subscriptions.forEach(unsubscribe => unsubscribe());
      for (const state of active) settle(state, 'capture-stopped');
      await Promise.all([...pending]);
      status.stoppedAt = new Date().toISOString();
      await writeFile(statusFile, JSON.stringify(status, null, 2) + '\n');
    },
  };
}
