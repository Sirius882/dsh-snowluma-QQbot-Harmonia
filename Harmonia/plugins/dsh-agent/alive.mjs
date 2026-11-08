import { apply as upstreamAlive } from '../../vendor/dsh-alive/lib/index.js';
import { readJson, writeJson } from '../../lib/store.mjs';
import { validateReply } from '../../brain/unified-router.mjs';
import { parseReplyJson } from '../../lib/reply-json.mjs';
import path from 'node:path';
import { auditAlive } from '../../lib/alive-audit.mjs';

export const name = 'harmonia-alive-adapter';
export const inject = ['agents', 'sessionController', 'schedule', 'llm', 'agentDefaultModel', 'webServer'];
export function originalOwnerText(content) {
  const text = (content || []).filter(x => x.type === 'text').map(x => x.text).findLast(text => text.includes('\n\n{')) || '';
  const offset = text.lastIndexOf('\n\n{');
  if (offset < 0) return null;
  try { const data = JSON.parse(text.slice(offset + 2)); return data.verifiedRole === 'OWNER' && data.message?.kind === 'private' ? data.message.text : null; }
  catch { return null; }
}
export async function apply(ctx, config) {
  const root = config.root;
  const sessions = await readJson(path.join(root, 'runtime/dsh-sessions.json'), {});
  if (!sessions['owner-private']) {
    sessions['owner-private'] = (await ctx.sessionController.create({ cwd: root, agentPreset: 'harmonia-owner' })).sessionId;
    await writeJson(path.join(root, 'runtime/dsh-sessions.json'), sessions);
  }
  const target = sessions['owner-private'];
  const aliveConfigFile = path.join(root, 'runtime/alive/alive-config.json');
  const aliveConfig = await readJson(aliveConfigFile, null);
  if (aliveConfig && aliveConfig.targetSession !== target) await writeJson(aliveConfigFile, { ...aliveConfig, targetSession: target });
  const previous = await readJson(path.join(root, 'runtime/proactive-scheduler.json'), {});
  if (previous.sessionId) {
    for (const item of await ctx.schedule.list({ sessionId: previous.sessionId })) {
      if (item.title === '哈尔莫妮娅找话题') await ctx.schedule.delete({ sessionId: previous.sessionId, id: item.id });
    }
  }
  let activeTurn = null;
  const turns = new Map();
  ctx.on('session/event', (session, event) => {
    if (session.id !== target) return;
    if (event.type === 'turn/start') { activeTurn = event.data.turn; turns.set(activeTurn, {}); return; }
    if (event.type === 'user/message' && activeTurn !== null && event.data.source?.kind === 'proactive') {
      const origin = turns.get(activeTurn);
      if (origin && !origin.proactive) Object.assign(origin, { proactive: true, loopId: event.data.source.loopId,
        continuationId: event.data.source.continuation === 'tsundere-urgency' ? event.data.source.continuationId : undefined,
        contextAt: event.data.source.contextAt });
      return;
    }
    if (event.type !== 'turn/end') return;
    const origin = turns.get(event.data.turn); turns.delete(event.data.turn);
    if (activeTurn === event.data.turn) activeTurn = null;
    if (!origin?.proactive) return;
    if (event.data.reason?.kind !== 'completed') {
      auditAlive(root, { type: 'proactive-outbox', turn: event.data.turn, outcome: 'turn-failed' }); return;
    }
    const messages = session.snapshotEvents().filter(e => e.type === 'assistant/message' && e.data.turn === event.data.turn)
      .map(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    try {
      const result = validateReply(parseReplyJson(messages.at(-1)));
      if (!result.reply || !result.bubbles.length && !result.sticker) {
        auditAlive(root, { type: 'proactive-outbox', turn: event.data.turn, outcome: 'silent' }); return;
      }
      void writeJson(path.join(root, 'runtime/proactive-outbox', `alive-${session.id}-${event.seq}.json`), {
        id: `alive-${session.id}-${event.seq}`, kind: 'alive', loopId: origin.loopId, continuationId: origin.continuationId,
        contextAt: origin.contextAt, createdAt: Date.now(), bubbles: result.bubbles, sticker: result.sticker, sources: result.sources,
      }).then(() => auditAlive(root, { type: 'proactive-outbox', turn: event.data.turn, loopId: origin.loopId, outcome: 'queued' }))
        .catch(() => { ctx.logger.warn('Alive outbox write failed'); auditAlive(root, { type: 'proactive-outbox', turn: event.data.turn, outcome: 'write-failed' }); });
    } catch { ctx.logger.warn('Alive reply invalid; not delivered'); auditAlive(root, { type: 'proactive-outbox', turn: event.data.turn, outcome: 'invalid-reply' }); }
  });
  // Adapt only the transport's event envelope, leaving upstream scheduling, mood and suppression rules intact.
  const adapted = new Proxy(ctx, { get(object, property) {
    if (property === 'on') return (event, listener, ...rest) => object.on(event, (session, entry) => {
      if (event !== 'session/event') return listener(session, entry);
      if (session.id !== target) return;
      if (entry.type === 'user/message' && ['user-rpc', 'user'].includes(entry.data.source?.kind)) {
        const text = originalOwnerText(entry.data.content);
        if (text === null) return;
        entry = { ...entry, data: { ...entry.data, source: { kind: 'qq' }, content: [{ type: 'text', text }] } };
      }
      return listener(session, entry);
    }, ...rest);
    const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value;
  } });
  upstreamAlive(adapted, {
    dataDir: path.join(root, 'runtime/alive'), targetSession: target, enabled: true, dryRun: false, harmoniaRoot: root,
    harmoniaLogDir: path.join(root, '../.cache/harmonia/alive-logs'),
    minSilenceMin: 45, cooldownMin: 120, maxPerHour: 1, maxPerDay: 5,
    quietHours: ['22:00-07:00'], moodInjection: false, includeRecall: false,
    emotionBypassQuota: false, emotionBypassMaster: false, greetingEnabled: false,
    freeTalkEnabled: true, freeTalkSilenceMin: 90, freeTalkGapMin: 120, lustModeEnabled: false, memeChancePercent: 0,
  });
}
