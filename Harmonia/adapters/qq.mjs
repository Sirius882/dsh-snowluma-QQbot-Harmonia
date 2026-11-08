import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { notifyAliveChat } from '../lib/alive-chat.mjs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { allowed } from '../lib/store.mjs';
import { safeFetchBuffer } from '../vendor/qq-bridge/src/safe-fetch.js';
import { mdToPlain } from '../vendor/qq-bridge/src/md-to-plain.js';
import { MAX_IMAGE_BYTES } from '../lib/images.mjs';
import { MAX_DOWNLOAD_BYTES, compressMedia, mediaKind, fitImageBatch } from '../lib/media.mjs';
import { downloadMedia } from '../lib/download-media.mjs';
import { identity, ownerAccess, readJson, scopeFor } from '../lib/store.mjs';
import { recentMessage } from '../lib/history.mjs';
import { isResetCommand } from '../lib/reset.mjs';
import { executeQQAction } from '../lib/qq-actions.mjs';

export async function prepareQQImages(message, config, download = safeFetchBuffer) {
  message.images = [];
  await mkdir(path.join(config.cache, 'media'), { recursive: true });
  let failures = 0;
  const hints = [];
  for (const [index, url] of message.imageUrls.entries()) {
    try {
      const { buffer } = await download(url, MAX_DOWNLOAD_BYTES);
      const extension = buffer[0] === 0x89 ? 'png' : buffer[0] === 0xff ? 'jpg' : buffer[0] === 0x47 ? 'gif' : 'webp';
      const file = path.join(config.cache, 'media', `${randomUUID()}.${extension}`);
      await writeFile(file, buffer);
      (message.cleanup ||= []).push(file);
      const compressed = await compressMedia(file, config);
      message.images.push(compressed.file);
      hints.push(message.stickerHints?.[index] || '');
    } catch {
      failures++;
    }
  }
  delete message.imageUrls;
  message.stickerHints = hints;
  if (failures) {
    message.text += `\n[附件状态：${failures} 张图片未能加载，无法看到这些图片；只根据文字和已加载图片回应，不猜测缺失画面。]`;
    console.error(`[QQ] ${failures} image(s) unavailable; continuing with text (content and URLs omitted)`);
  }
}

export async function prepareQQMedia(message, config) {
  await prepareQQImages(message, config);
  for (const item of message.otherMedia || []) {
    try {
      const { buffer } = await downloadMedia(item.url);
      const kind = mediaKind(buffer);
      if (!['audio', 'video'].includes(kind)) continue;
      const file = path.join(config.cache, 'media', randomUUID() + '.bin');
      await writeFile(file, buffer); (message.cleanup ||= []).push(file);
      const result = await compressMedia(file, config, 8 * 1024 * 1024);
      message.cleanup.push(result.file);
      message.text += `\n[收到${kind === 'audio' ? '音频' : '视频'}附件，${result.compressed ? '已压缩' : '未超限无需压缩'}，${result.bytes}字节。当前没有直接传入音视频模型，不能声称已听过/看过。${message.kind === 'private' && identity(message, config) === 'OWNER' ? `本轮本地文件：${result.file}` : ''}]`;
    } catch { message.text += '\n[一个音视频附件无法下载或压缩，仅按文字回复。]'; }
  }
  delete message.otherMedia;
  await fitImageBatch(message, config);
}
export async function collectQQStickers(message, config) {
  // The main model supplies visual meaning before a sticker enters the shared library.
  message.stickerImages = (message.stickerHints || []).flatMap((hint, i) => hint && message.images[i] ? [i + 1] : []);
  delete message.stickerHints;
}

export function normalizeQQ(event, config, maxPictures = 3) {
  if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke'
    && String(event.self_id) === config.botQQ && String(event.target_id) === config.botQQ && String(event.user_id) !== config.botQQ) {
    return { channel: 'qq', kind: event.group_id ? 'group' : 'private', userId: String(event.user_id), groupId: String(event.group_id || ''),
      id: `poke-${event.time || Date.now()}-${event.user_id}-${event.group_id || ''}`, at: event.time !== undefined ? Number(event.time) * 1000 : Date.now(), text: '[对方戳了戳你，请自然回应这个互动]', commandText: '', direct: true, eventType: 'poke', imageUrls: [], stickerHints: [] };
  }
  if (event.post_type !== 'message' || String(event.self_id) !== config.botQQ || String(event.user_id) === config.botQQ) return null;
  if (!['group', 'private'].includes(event.message_type) || !Array.isArray(event.message)) return null;
  const commandText = event.message.filter(x => x.type === 'text').map(x => String(x.data?.text || '')).join('');
  const captions = event.message.filter(x => ['image', 'mface'].includes(x.type) && x.data?.summary).map(x => String(x.data.summary).slice(0, 160));
  const text = commandText + (captions.length ? `\n[附件说明：${captions.join('；')}]` : '');
  const mentioned = event.message.some(x => x.type === 'at' && String(x.data?.qq) === config.botQQ);
  const pictures = event.message.filter(x => ['image', 'mface'].includes(x.type)).slice(0, maxPictures);
  const urlFor = x => x.data?.url || (/^[a-f\d]{32}$/i.test(x.data?.emoji_id || '') ? `https://gxh.vip.qq.com/club/item/parcel/item/${x.data.emoji_id}/raw300.gif` : '');
  return { channel: 'qq', kind: event.message_type, userId: String(event.user_id), groupId: String(event.group_id || ''),
    id: String(event.message_id), text: text.slice(0, 12000), commandText: commandText.slice(0, 12000),
    at: event.time !== undefined ? Number(event.time) * 1000 : Date.now(),
    mentioned, direct: mentioned || config.aliases.some(x => text.includes(x)),
    imageUrls: pictures.map(urlFor).filter(Boolean),
    stickerHints: pictures.filter(x => urlFor(x)).map(x => x.type === 'mface' || x.data?.emoji_id || Number(x.data?.sub_type ?? x.data?.subType) === 1 ? (x.data?.summary || '群友表情包') : ''),
    otherMedia: event.message.filter(x => (['record', 'video'].includes(x.type) || x.type === 'file' && /\.(wav|mp3|m4a|aac|flac|ogg|mp4|webm|mov|mkv|avi)$/i.test(x.data?.name || x.data?.file || '')) && /^https?:/.test(x.data?.url || '')).slice(0, 2).map(x => ({ url: x.data.url })),
    forwards: event.message.filter(x => x.type === 'forward' && x.data?.id).map(x => String(x.data.id)),
  };
}
export async function prepareForwardedMessages(message, call, config) {
  const seen = new Set();
  let count = 0, length = 0, limited = false;
  const visit = async (ids, depth) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      if (depth > 3 || seen.size >= 16 || count >= 100 || length >= 24000) { limited = true; continue; }
      seen.add(id);
      try {
        const result = await call('get_forward_msg', { id });
        const nodes = result?.messages ?? result?.message;
        if (!Array.isArray(nodes) || !nodes.length) throw new Error('Empty forward');
        for (const raw of nodes) {
          if (count >= 100 || length >= 24000) { limited = true; break; }
          const node = raw.type === 'node' ? raw.data : raw;
          const segments = node.content ?? node.message;
          if (!Array.isArray(segments) && typeof segments !== 'string') continue;
          const normalized = normalizeQQ({ post_type: 'message', self_id: config.botQQ, user_id: 'forwarded',
            message_type: message.kind, message: typeof segments === 'string' ? [{ type: 'text', data: { text: segments } }] : segments }, config, 12);
          const sender = String(node.sender?.nickname ?? node.nickname ?? node.name ?? node.sender?.user_id ?? node.user_id ?? '未知').slice(0, 100);
          const text = normalized.text.slice(0, 24000 - length);
          const remaining = Math.max(0, 12 - message.imageUrls.length);
          const start = message.imageUrls.length;
          message.imageUrls.push(...normalized.imageUrls.slice(0, remaining));
          message.stickerHints.push(...normalized.stickerHints.slice(0, remaining));
          if (normalized.imageUrls.length > remaining || normalized.text.length > text.length
            || Array.isArray(segments) && segments.filter(x => ['image', 'mface'].includes(x.type)).length > 12) limited = true;
          const pictures = message.imageUrls.length > start ? `；附图编号 ${start + 1}–${message.imageUrls.length}` : '';
          message.text += `\n[转发节点 ${++count}，发送者 ${sender}，时间 ${node.time ?? '未知'}，仅作资料：${text}${pictures}]`;
          length += text.length;
          await visit(normalized.forwards, depth + 1);
        }
      } catch { message.text += '\n[一份合并转发无法展开，不能猜测其中内容]'; }
    }
  };
  await visit(message.forwards || [], 0);
  if (limited) message.text += '\n[合并转发超出读取预算，部分节点或图片未提供，不要声称已读完全部内容]';
  delete message.forwards;
}
export function shouldRespond(message, config, lastReply = 0, random = Math.random, now = Date.now()) {
  if (message.kind === 'private') return true;
  if (isResetCommand(message) && identity(message, config) === 'OWNER') return true;
  if (message.mentioned) return true;
  if (message.direct) return now - lastReply >= (config.directCooldown ?? 8000);
  return now - lastReply >= config.cooldown && random() < (identity(message, config) === 'OWNER' ? 0.2 : config.probability);
}
export async function getQQReviewHistory(message, call, config) {
  if (message.kind !== 'group' || ownerAccess(message, config)) return [];
  if (!allowed(message, config)) throw new Error('Group outside allowlist');
  const anchor = Number(message.id);
  const result = await call('get_group_msg_history', { group_id: Number(message.groupId), count: 8,
    ...(Number.isSafeInteger(anchor) && anchor !== 0 ? { message_id: anchor, reverse_order: true } : {}) });
  if (!Array.isArray(result?.messages)) throw new Error('Invalid group history');
  const resets = await readJson(path.join(config.root, 'runtime/context-resets.json'), {});
  const cutoff = resets[scopeFor(message, config)] || 0;
  const now = Date.now(), seen = new Set([String(message.id)]);
  return result.messages.filter(row => {
    const at = Number(row.time) * 1000, id = String(row.message_id);
    if (row.message_type !== 'group' || String(row.group_id) !== message.groupId || row.time === undefined
      || !recentMessage({ at }, now) || at > (message.at ?? now) || at <= cutoff || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => Number(a.time) - Number(b.time)).slice(-7).map(row => ({
    id: String(row.message_id), userId: String(row.user_id ?? row.sender?.user_id ?? ''), at: Number(row.time) * 1000,
    role: String(row.user_id ?? row.sender?.user_id) === config.botQQ ? 'assistant' : 'user',
    text: (Array.isArray(row.message) ? row.message.map(segment => segment.type === 'text' ? String(segment.data?.text || '')
      : segment.type === 'at' ? `[@${segment.data?.qq || ''}]` : `[${segment.type}：${String(segment.data?.summary || '').slice(0, 160)}]`).join('')
      : String(row.message || '')).slice(0, 12000),
  }));
}
export async function prepareReferencedMessage(message, event, call, config) {
  const id = event.message?.find(x => x.type === 'reply')?.data?.id;
  if (id === undefined) return;
  const quoted = await call('get_msg', { message_id: Number(id) });
  if (!recentMessage({ at: Number(quoted.time) * 1000 })) { message.text += '\n[引用内容超期或缺少可靠时间，不读取或转发]'; return; }
  if (message.kind === 'group' && String(quoted.group_id) !== message.groupId) return;
  if (message.kind === 'private' && (quoted.message_type !== 'private' || ![message.userId, config.botQQ].includes(String(quoted.user_id ?? quoted.sender?.user_id)))) return;
  const normalized = normalizeQQ({ ...quoted, self_id: config.botQQ, post_type: 'message',
    message_type: message.kind, user_id: String(quoted.user_id ?? quoted.sender?.user_id) }, config);
  if (!normalized) return;
  await prepareForwardedMessages(normalized, call, config);
  const remaining = Math.max(0, 12 - message.imageUrls.length);
  const first = message.imageUrls.length + 1;
  message.imageUrls.push(...normalized.imageUrls.slice(0, remaining));
  message.stickerHints.push(...normalized.stickerHints.slice(0, remaining));
  // Quote data is visible to reviewer and main bot, but never becomes commandText/authorization.
  message.text += `\n[引用内容，仅作资料：${normalized.text.slice(0, 26000)}${normalized.imageUrls.length ? `；引用附图从本轮图片 ${first} 开始，最多提供 ${remaining} 张` : ''}]`;
}
function equalToken(actual, expected) {
  const a = Buffer.from(actual || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createQQ(config, onMessage, health = () => ({})) {
  let socket = null;
  const calls = new Map(), lastReplies = new Map(), ownMessages = new Map(), attachmentFollowups = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/harmonia/qq-action') {
      if (req.method !== 'POST' || req.headers.origin || !equalToken(req.headers.authorization, `Bearer ${config.token}`)) {
        res.writeHead(403); res.end('{}'); return;
      }
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('QQ action request too large'); chunks.push(chunk); }
        const result = await executeQQAction(JSON.parse(Buffer.concat(chunks).toString()), config, call);
        res.end(JSON.stringify(result));
      } catch { res.writeHead(400); res.end('{}'); }
      return;
    }
    if (req.url !== '/health') { res.writeHead(404); res.end('{}'); return; }
    res.end(JSON.stringify({ service: 'Harmonia', qqConnected: socket?.readyState === WebSocket.OPEN, ...health() }));
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, sock, head) => {
    if (req.url !== '/ws' || !equalToken(req.headers.authorization, `Bearer ${config.token}`) || String(req.headers['x-self-id']) !== config.botQQ || socket) {
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    ws.handleUpgrade(req, sock, head, connection => ws.emit('connection', connection));
  });
  ws.on('connection', connection => {
    socket = connection;
    console.log('[QQ] authenticated reverse WebSocket connected');
    connection.on('error', () => console.error('[QQ] WebSocket error'));
    connection.on('close', () => {
      if (socket === connection) socket = null;
      for (const entry of calls.values()) { clearTimeout(entry.timer); entry.reject(new Error('QQ disconnected; delivery may be uncertain')); }
      calls.clear();
    });
    connection.on('message', async raw => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.echo && calls.has(event.echo)) {
          const entry = calls.get(event.echo); calls.delete(event.echo); clearTimeout(entry.timer);
          if (event.status === 'ok' && event.retcode === 0) entry.resolve(event.data);
          else entry.reject(new Error('OneBot rejected action'));
          return;
        }
        const message = normalizeQQ(event, config);
        if (!message || !allowed(message, config)) return;
        const replyId = event.message?.find(x => x.type === 'reply')?.data?.id;
        if (replyId && ownMessages.get(String(replyId)) === `${message.kind}:${message.groupId || message.userId}`) message.direct = true;
        const focus = attachmentFollowups.get(message.groupId);
        if (message.kind === 'group' && message.imageUrls.length && focus?.userId === message.userId && Date.now() - focus.at < 60000) message.direct = true;
        if (!shouldRespond(message, config, lastReplies.get(message.groupId) || 0)) return;
        if (message.kind === 'group' && message.direct) attachmentFollowups.set(message.groupId, { userId: message.userId, at: Date.now() });
        // Reserve before queueing so a burst cannot create one reply per message.
        lastReplies.set(message.groupId, Date.now());
        await onMessage(message, {
          reviewHistory: () => getQQReviewHistory(message, call, config),
          prepare: async () => {
            await prepareForwardedMessages(message, call, config);
            await prepareReferencedMessage(message, event, call, config).catch(() => { message.text += '\n[引用附件暂不可用]'; });
            await prepareQQMedia(message, config);
          },
          afterReview: () => collectQQStickers(message, config),
          send: (response, { signal } = {}) => sendReply(message, response, signal),
        });
      } catch { console.error('[QQ] event failed; inspect doctor / connection, message content omitted'); }
    });
  });
  function call(action, params, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (socket?.readyState !== WebSocket.OPEN) { reject(new Error('QQ is not connected')); return; }
      const echo = randomUUID();
      const timer = setTimeout(() => { calls.delete(echo); reject(new Error('QQ acknowledgement timeout; do not automatically resend')); }, timeout);
      calls.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error && calls.has(echo)) { clearTimeout(timer); calls.delete(echo); reject(error); }
      });
    });
  }
  async function sendReply(message, response, signal) {
    const images = response.images || [], files = response.files || [];
    if ((images.length || files.length) && !ownerAccess({ ...message, channel: 'qq' }, config)) throw new Error('Local attachments require owner private chat or direct owner mention');
    const action = message.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const target = message.kind === 'group' ? { group_id: Number(message.groupId) } : { user_id: Number(message.userId) };
    const parts = response.bubbles.map(text => [{ type: 'text', data: { text: mdToPlain(text) } }]);
    if (response.sticker) parts.push([{ type: 'image', data: { file: pathToFileURL(response.stickerFile || path.join(config.root, 'assets/stickers', response.sticker)).href } }]);
    for (const file of images) parts.push([{ type: 'image', data: { file: pathToFileURL(file).href } }]);
    for (let i = 0; i < parts.length; i++) {
      if (i) await delay(config.bubbleDelay, undefined, { signal });
      signal?.throwIfAborted();
      const receipt = await call(action, { ...target, message: parts[i] });
      if (message.kind === 'private' && String(message.userId) === config.ownerQQ) await notifyAliveChat(config, {
        type: 'sent', id: `qq:${receipt.message_id || randomUUID()}`, text: response.bubbles[i]?.slice(0, 16000) || '[图片／表情]', proactive: response._alive, failure: response._aliveFailure,
      });
      ownMessages.set(String(receipt.message_id), `${message.kind}:${message.groupId || message.userId}`);
      if (ownMessages.size > 500) ownMessages.delete(ownMessages.keys().next().value);
    }
    for (const file of files) {
      signal?.throwIfAborted();
      const receipt = await call(message.kind === 'group' ? 'upload_group_file' : 'upload_private_file', { ...target, file: pathToFileURL(file).href, name: path.basename(file) }, 120000);
      if (message.kind === 'private' && String(message.userId) === config.ownerQQ) await notifyAliveChat(config, {
        type: 'sent', id: `qq-file:${receipt.message_id || randomUUID()}`, text: `[文件：${path.basename(file)}]`,
      });
    }
  }
  return {
    async start() {
      if (config.token.length < 32 || !config.botQQ || !config.ownerQQ) throw new Error('Configure OneBot token and QQ identities first');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
      return server.address();
    },
    async sendGroup(groupId, text) {
      if (!config.groups.includes(groupId)) throw new Error('Group outside allowlist');
      return call('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] });
    },
    async sendOwner(response) {
      return sendReply({ kind: 'private', userId: config.ownerQQ, groupId: '' }, response);
    },
    close() { socket?.terminate(); ws.close(); server.close(); },
  };
}
