import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';
import { resolveSticker } from './stickers.mjs';
import { readAliveStatus } from './alive-chat.mjs';

export async function drainProactive(config, transports, now = Date.now(), request = fetch) {
  const directory = path.join(config.root, 'runtime/proactive-outbox');
  const files = await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const stateFile = path.join(config.root, 'runtime/proactive-delivery.json');
  const state = await readJson(stateFile, { urls: [] });
  const activity = await readJson(path.join(config.root, 'runtime/owner-activity.json'), {});
  const resets = await readJson(path.join(config.root, 'runtime/context-resets.json'), {});
  for (const file of files.sort()) {
    const target = path.join(directory, file), item = await readJson(target);
    if (item.state || (!item.sources?.length && item.kind !== 'alive')) continue;
    if ((item.contextAt ?? item.createdAt) <= (resets['owner-private'] || 0)) {
      item.state = 'cancelled-context-reset'; await writeJson(target, item); continue;
    }
    if (item.continuationId) {
      const alive = await readAliveStatus(config, request);
      if (!alive?.continuationAllowed || !alive.tsundere?.active || alive.tsundere.urgencyId !== item.continuationId
        || now >= alive.tsundere.expiresAt) {
        item.state = 'cancelled-continuation'; await writeJson(target, item); continue;
      }
    }
    if (item.sources?.length && item.sources.every(source => (state.urls || []).includes(source.url))) {
      item.state = 'duplicate'; await writeJson(target, item); continue;
    }
    if (now - item.createdAt > 6 * 3600000) { item.state = 'expired'; await writeJson(target, item); continue; }
    const channel = activity.channel === 'wechat' ? 'wechat' : 'qq';
    if (!transports[channel]) return { sent: false, reason: 'channel-unavailable' };
    const bubbles = [...item.bubbles];
    const stickerFile = await resolveSticker(item.sticker, config);
    for (const source of item.sources) if (!bubbles.some(b => b.includes(source.url))) bubbles.push(source.url);
    // Persist before effects; an uncertain send is never replayed on the other platform.
    item.state = 'sending-or-uncertain'; item.channel = channel; await writeJson(target, item);
    try {
      await transports[channel]({ bubbles, sticker: stickerFile ? item.sticker : '', ...(stickerFile ? { stickerFile } : {}),
        _alive: { id: item.id, loopId: item.loopId } });
      item.state = 'sent';
      state.urls = [...new Set([...(state.urls || []), ...item.sources.map(s => s.url)])].slice(-300);
      await writeJson(stateFile, state);
      await writeJson(target, item);
      return { sent: true, channel };
    } catch { item.state = 'failed-or-uncertain'; await writeJson(target, item); return { sent: false, reason: 'delivery-uncertain' }; }
  }
  return { sent: false, reason: 'no-candidate' };
}
