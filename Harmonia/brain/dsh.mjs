import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeApiClient, unwrap, createTurnCollector } from '../vendor/qq-bridge/src/dsh-client.js';
import WebSocket from 'ws';
import { readJson, writeJson } from '../lib/store.mjs';
import { MAX_IMAGE_BYTES } from '../lib/images.mjs';
import { currentTime } from '../lib/clock.mjs';
import { parseReplyJson as parseDshReply } from '../lib/reply-json.mjs';
export { parseDshReply };

export function createDshClient(config) {
  return new NodeApiClient(config.dshUrl, config.timeout);
}
export async function dshStatus(config, client = createDshClient(config), signal) {
  const catalog = unwrap(await client.callUnary('session/modelCatalog', {}, signal), 'model catalog');
  const selected = catalog.default;
  const ready = catalog.groups.some(group => group.id === selected?.provider && group.models.some(model => model.id === selected.model));
  return { ready, provider: selected?.provider || '', model: selected?.model || '',
    reasoningEffort: selected?.reasoningEffort,
    message: ready ? 'ready' : '请在 DSH 全局设置中填写模型提供商，并设置默认模型。' };
}
export class DshTurnError extends Error {
  constructor(code, message) { super(message); this.name = 'DshTurnError'; this.code = code; }
}
export function checkTurnResult(reason, text) {
  if (reason?.kind === 'error') {
    if (reason.error?.code === 'CONTEXT_WINDOW_EXCEEDED') throw new DshTurnError('DSH_CONTEXT_OVERFLOW', 'DSH session exceeded its context capacity');
    const busy = /server_busy|servers are currently busy/i.test(reason.error?.message || '');
    throw new DshTurnError(busy ? 'DSH_BUSY' : 'DSH_UPSTREAM_ERROR', busy ? 'Model provider is busy' : 'DSH model request failed');
  }
  if (reason?.kind === 'aborted') throw new DshTurnError('DSH_ABORTED', 'DSH turn was cancelled');
  if (!text) throw new DshTurnError('DSH_EMPTY_RESPONSE', 'DSH produced no assistant response');
  return text;
}
export async function runDsh({ prompt, images = [], scope, owner = scope === 'owner-private', signal: cancel }, config, client = createDshClient(config), executeTurn = followTurn) {
  const deadline = AbortSignal.timeout(config.maxTurnMs ?? 900000);
  const signal = cancel ? AbortSignal.any([cancel, deadline]) : deadline;
  signal.throwIfAborted();
  const rpc = async (name, request) => unwrap(await client.callUnary(name, request, signal), name);
  const state = await dshStatus(config, client, signal);
  if (!state.ready) throw new Error(state.message);
  const file = path.join(config.root, 'runtime/dsh-sessions.json');
  const sessions = await readJson(file, {});
  const key = owner && scope !== 'owner-private' ? `${scope}:owner-mention` : scope;
  let sessionId = sessions[key];
  if (!sessionId) {
    const created = await rpc('session/create', { cwd: config.root, agentPreset: owner ? 'harmonia-owner' : 'harmonia-public' });
    sessionId = created.sessionId;
    sessions[key] = sessionId;
    await writeJson(file, sessions);
    await rpc('session/rename', { sessionId, title: `哈尔莫妮娅 · ${scope}` });
  }
  // Follow the global default on each turn so changing it in DSH takes effect for both transports.
  await rpc('session/selectModel', { sessionId, ...stateSelection(state) });
  const content = [{ type: 'text', text: prompt }];
  for (const image of images) {
    const bytes = await readFile(image);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds DSH intake limit');
    const mediaType = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : 'image/webp';
    content.push({ type: 'image', mediaType, data: bytes.toString('base64') });
  }
  content.push({ type: 'text', text: currentTime() });
  let submitted = false;
  try {
    const text = await executeTurn(client, sessionId, () => {
      signal.throwIfAborted();
      submitted = true;
      return rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content, clientTimeZone: 'Asia/Shanghai' });
    }, signal, { idleMs: config.timeout });
    if (!text) throw new Error('DSH produced no assistant response');
    return parseDshReply(text);
  } catch (error) {
    if (submitted) await client.callUnary('session/cancel', { sessionId }, AbortSignal.timeout(3000)).catch(() => {});
    cancel?.throwIfAborted();
    if (signal.aborted && error.code !== 'DSH_IDLE_TIMEOUT') throw new DshTurnError('DSH_TURN_TIMEOUT', 'DSH whole-turn deadline exceeded');
    throw error;
  }
}
function stateSelection(state) { return { provider: state.provider, model: state.model,
  ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}) }; }

// rc.5 exposes session/follow over remote.mux; subscribe before submitting to avoid losing fast replies.
export async function followTurn(client, sessionId, submit, signal, { idleMs = 180000 } = {}) {
  await client.ensureAuth(signal);
  const url = new URL('/api/remote.mux', client.baseUrl); url.protocol = 'ws:';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Cookie: client.cookie }, maxPayload: 16 * 1024 * 1024 });
    const streamId = randomUUID(), collector = createTurnCollector();
    let submitted = false, settled = false, finalText = '', idleTimer;
    const progress = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(new DshTurnError('DSH_IDLE_TIMEOUT', 'DSH produced no progress before idle deadline')), idleMs);
      idleTimer.unref?.();
    };
    const finish = (error, text) => {
      if (settled) return; settled = true;
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', onAbort); socket.terminate();
      if (error) reject(error); else resolve(text);
    };
    const onAbort = () => finish(new DshTurnError('DSH_TURN_TIMEOUT', 'DSH whole-turn deadline exceeded'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    progress();
    socket.on('error', () => finish(new DshTurnError('DSH_DISCONNECTED', 'DSH event connection failed')));
    socket.on('close', () => finish(new DshTurnError('DSH_DISCONNECTED', 'DSH event connection closed before result')));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20, assistantStream: true } } } })));
    socket.on('message', async bytes => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.streamId !== streamId) return;
        if (frame.type === 'end') throw new Error('DSH session stream ended');
        if (frame.type !== 'item') return;
        if (['snapshot', 'event', 'assistant-stream'].includes(frame.value?.type)) progress();
        if (frame.value?.type === 'snapshot' && !submitted) {
          submitted = true;
          const active = new Set();
          for (const record of frame.value.records || []) {
            if (record.event?.type === 'turn/start') active.add(record.event.data.turn);
            if (record.event?.type === 'turn/end') active.delete(record.event.data.turn);
          }
          if (active.size) throw new Error('DSH session already running; no duplicate submitted');
          await submit();
        } else if (frame.value?.type === 'event' && submitted) {
          if (frame.value.event.type === 'assistant/message') {
            const blocks = frame.value.event.data.message?.content || [];
            if (!blocks.some(block => block.type === 'tool-call')) {
              finalText = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
            }
          }
          const result = collector.push(frame.value.event);
          if (result) finish(null, checkTurnResult(result.reason, finalText));
        }
      } catch (error) { finish(error); }
    });
  });
}
