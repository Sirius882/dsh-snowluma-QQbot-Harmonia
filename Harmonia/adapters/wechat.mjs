import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createIlinkClient, extractText } from '../vendor/wechat-bridge/lib/ilink.mjs';
import { downloadMediaFromItem, sendMediaFile } from '../vendor/wechat-bridge/lib/ilink-media.mjs';
import { allowed, readJson, writeJson } from '../lib/store.mjs';
import { configureNetwork } from '../lib/network.mjs';
import { compressMedia, fitImageBatch } from '../lib/media.mjs';
import { notifyAliveChat } from '../lib/alive-chat.mjs';

export function officialBase(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')) || url.username || url.password || url.port) throw new Error('Untrusted iLink endpoint');
  return url.origin;
}
export function normalizeWechat(msg) {
  if (msg.message_type !== 1 || typeof msg.from_user_id !== 'string' || !msg.message_id) return null;
  const text = extractText(msg).slice(0, 12000);
  // Only literal text from this message can authorize a cross-post, never quote text or voice transcription.
  const parts = (msg.item_list || []).filter(x => x.type === 1);
  const commandText = parts.length === 1 ? String(parts[0].text_item?.text || '') : '';
  return { channel: 'wechat', kind: 'private', userId: msg.from_user_id, id: String(msg.message_id), text, commandText, direct: true,
    at: msg.create_time_ms !== undefined ? Number(msg.create_time_ms) : Date.now() };
}
export async function sendWechatOwner(config, response) {
  const auth = await readJson(path.join(config.root, 'runtime/wechat-auth.json'), null);
  const contacts = await readJson(path.join(config.root, 'runtime/wechat-contacts.json'), {});
  const contact = contacts[config.ownerWechat];
  if (!auth?.token || !contact?.contextToken) throw new Error('WeChat owner context unavailable');
  await configureNetwork(config);
  const client = createIlinkClient({ token: auth.token, baseUrl: officialBase(auth.baseUrl), channelVersion: auth.channelVersion });
  for (const text of response.bubbles) {
    await client.sendMessage({ to: config.ownerWechat, text, contextToken: contact.contextToken });
    await notifyAliveChat(config, { type: 'sent', id: `wechat:${randomUUID()}`, text, proactive: response._alive });
  }
  if (response.sticker) {
    await sendMediaFile({ client, filePath: response.stickerFile || path.join(config.root, 'assets/stickers', response.sticker), to: config.ownerWechat, contextToken: contact.contextToken });
    await notifyAliveChat(config, { type: 'sent', id: `wechat:${randomUUID()}`, text: '[表情]', proactive: response._alive });
  }
}
export async function runWechat(config, onMessage, status, signal, clientFactory = createIlinkClient) {
  await configureNetwork(config);
  const auth = await readJson(path.join(config.root, 'runtime/wechat-auth.json'), null);
  if (!auth?.token) throw new Error('WeChat not paired: run start-wechat-login.bat');
  const client = clientFactory({ token: auth.token, baseUrl: officialBase(auth.baseUrl), channelVersion: auth.channelVersion || '2.4.6' });
  const cursorFile = path.join(config.root, 'runtime/wechat-cursor.json');
  let cursor = await readJson(cursorFile, { buf: '' });
  let checkpoint = Promise.resolve(), deliveryError;
  const inFlight = new Set();
  let failures = 0;
  status.wechat = 'polling';
  await client.notifyStart();
  try {
    while (!signal.aborted) {
      try {
        if (deliveryError) {
          await Promise.allSettled([...inFlight]);
          await checkpoint.catch(() => {});
          cursor = await readJson(cursorFile, { buf: '' });
          checkpoint = Promise.resolve();
          const error = deliveryError; deliveryError = undefined; throw error;
        }
        const batch = await client.getUpdates(cursor.buf, 35000, signal);
        if (batch.ret === -14 || batch.errcode === -14) throw new Error('STALE_TOKEN');
        if (batch.ret !== 0 || (batch.errcode && batch.errcode !== 0)) throw new Error('iLink getUpdates failed');
        failures = 0; status.wechat = 'polling';
        const deliveries = [];
        for (const msg of batch.msgs) {
          if (signal.aborted) break;
          const message = normalizeWechat(msg);
          if (!message || !allowed(message, config)) continue;
          const contextToken = msg.context_token;
          if (!contextToken) { console.error('[WeChat] no context token; message skipped'); continue; }
          const contactsFile = path.join(config.root, 'runtime/wechat-contacts.json');
          const contacts = await readJson(contactsFile, {});
          contacts[message.userId] = { contextToken, updatedAt: Date.now() };
          await writeJson(contactsFile, contacts);
          const delivery = Promise.resolve().then(() => onMessage(message, {
            prepare: async () => {
              message.images = [];
              for (const item of (msg.item_list || []).filter(x => [2,3,4,5].includes(x.type)).slice(0, 3)) {
                if (item.type === 4 && !/\.(png|jpe?g|gif|webp|wav|mp3|m4a|aac|flac|ogg|mp4|webm|mov|mkv|avi)$/i.test(item.file_item?.file_name || '')) continue;
                const media = (item.image_item || item.voice_item || item.file_item || item.video_item)?.media;
                if (media?.full_url) {
                  const url = new URL(media.full_url);
                  if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username) throw new Error('Untrusted media URL');
                }
                try {
                  const result = await downloadMediaFromItem({ item, saveDir: path.join(config.cache, 'media', randomUUID()) });
                  if (!result) throw new Error('Media download failed');
                  (message.cleanup ||= []).push(result.savedPath);
                  const converted = await compressMedia(result.savedPath, config);
                  message.cleanup.push(converted.file);
                  if (converted.kind === 'image') message.images.push(converted.file);
                  else message.text += `\n[收到媒体文件，${converted.compressed ? '已压缩' : '未超限保留原件'}。当前未传入原生音视频模型，不要声称已听过/看过。]`;
                } catch { message.text += '\n[一个媒体附件无法读取，仅根据文字回应。]'; }
              }
              if (!message.text && !message.images.length) message.text = '[收到暂不支持理解的媒体，请明确告知当前仅支持文字、语音转写和图片]';
              await fitImageBatch(message, config);
            },
            send: async (response, { signal: turnSignal } = {}) => {
              const attachments = [...(response.images || []), ...(response.files || [])];
              if (attachments.length && message.userId !== config.ownerWechat) throw new Error('Local attachments require owner private chat');
              for (let i = 0; i < response.bubbles.length; i++) {
                if (i) await delay(config.bubbleDelay, undefined, { signal: turnSignal });
                turnSignal?.throwIfAborted();
                await client.sendMessage({ to: message.userId, text: response.bubbles[i], contextToken });
                if (message.userId === config.ownerWechat) await notifyAliveChat(config, { type: 'sent', id: `wechat:${message.id}:${i}`, text: response.bubbles[i], failure: response._aliveFailure });
              }
              turnSignal?.throwIfAborted();
              if (response.sticker) {
                await sendMediaFile({ client, filePath: response.stickerFile || path.join(config.root, 'assets/stickers', response.sticker), to: message.userId, contextToken });
                if (message.userId === config.ownerWechat) await notifyAliveChat(config, { type: 'sent', id: `wechat:${message.id}:sticker`, text: '[表情]' });
              }
              for (const filePath of attachments) {
                turnSignal?.throwIfAborted();
                await sendMediaFile({ client, filePath, to: message.userId, contextToken });
                if (message.userId === config.ownerWechat) await notifyAliveChat(config, { type: 'sent', id: `wechat:${randomUUID()}`, text: '[附件]' });
              }
            },
          }));
          deliveries.push(delivery); inFlight.add(delivery);
          delivery.then(() => inFlight.delete(delivery), error => { inFlight.delete(delivery); deliveryError ||= error; });
        }
        if (!signal.aborted) {
          cursor = { buf: batch.get_updates_buf };
          const nextCursor = cursor;
          // Keep polling so /reset can interrupt inference; commit cursors only after durable delivery outcomes.
          const completed = Promise.all(deliveries); completed.catch(() => {});
          checkpoint = checkpoint.then(async () => { await completed; await writeJson(cursorFile, nextCursor); });
          checkpoint.catch(error => { deliveryError ||= error; });
        }
      } catch (error) {
        if (error.message === 'STALE_TOKEN') { status.wechat = 'login-required'; throw new Error('WeChat credential expired: run start-wechat-login.bat'); }
        failures++; status.wechat = 'retrying';
        console.error(`[WeChat] poll failure ${failures}; retrying, sensitive diagnostics omitted`);
        await delay(Math.min(30000, failures * 3000), undefined, { signal }).catch(() => {});
      }
    }
  } finally {
    await Promise.allSettled([...inFlight, checkpoint]);
    await client.notifyStop();
  }
}
