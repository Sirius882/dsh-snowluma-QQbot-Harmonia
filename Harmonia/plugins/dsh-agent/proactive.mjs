import { readJson, writeJson } from '../../lib/store.mjs';
import { nextWake, evidenceUrls, verifiedCandidate } from '../../lib/proactive-policy.mjs';
import path from 'node:path';

export const name = 'harmonia-proactive';
export const inject = ['sessionController', 'schedule'];
export function apply(ctx, config) {
  const root = config.root;
  const stateFile = path.join(root, 'runtime/proactive-scheduler.json');
  let disposed = false, sessionId, running = Promise.resolve();
  const scheduleNext = async () => {
    if (disposed || !sessionId) return;
    const active = await ctx.schedule.list({ sessionId });
    if (active.some(item => item.title === '哈尔莫妮娅找话题')) return;
    const at = nextWake();
    const task = await ctx.schedule.create(sessionId, { title: '哈尔莫妮娅找话题', at: new Date(at).toISOString(),
      prompt: '一次自主探索：先读取并维护统一记忆 memories.json 中的兴趣与信源，按兴趣真实搜索网上新信息，必要时读取 B 站视频。选一个值得和主人聊的话题，结合你的想法自然开口。没有可靠、合适的新内容就 reply=false。只输出约定 JSON 和 sources，不直接操作 QQ/微信/B站写入。', });
    await writeJson(stateFile, { sessionId, taskId: task.id, nextAt: at });
  };
  const queued = fn => { running = running.then(fn).catch(() => ctx.logger.warn('Harmonia proactive task failed; inspect private DSH session')); return running; };
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId || event.type !== 'turn/end') return;
    void queued(async () => {
      const events = session.snapshotEvents().filter(e => e.data?.turn === event.data.turn);
      const evidence = evidenceUrls(events);
      const messages = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content || [])
        .filter(x => x.type === 'text').map(x => x.text);
      let outcome = 'silent-or-invalid';
      try {
        const value = JSON.parse(messages.at(-1)?.replace(/^```json\s*|\s*```$/g, '') || '{}');
        const sent = await readJson(path.join(root, 'runtime/proactive-delivery.json'), {});
        const candidate = verifiedCandidate(value, evidence, sent.urls || []);
        if (candidate) { outcome = 'verified-candidate'; await writeJson(path.join(root, 'runtime/proactive-outbox', `${session.id}-${event.seq}.json`), {
          id: `${session.id}-${event.seq}`, createdAt: Date.now(), ...candidate,
        }); }
      } catch { /* Invalid or silent output is never forwarded. */ }
      await writeJson(path.join(root, 'runtime/proactive-last-run.json'), {
        sessionId, at: Date.now(), outcome, searched: evidence.searched, sourceCount: evidence.urls.size,
      });
      await scheduleNext();
    });
  });
  ctx.effect(() => {
    void queued(async () => {
      const previous = await readJson(stateFile, {});
      sessionId = previous.sessionId;
      if (!sessionId) {
        const created = await ctx.sessionController.create({ cwd: root, agentPreset: 'harmonia-proactive' });
        sessionId = created.sessionId;
        await ctx.sessionController.rename({ sessionId, title: '哈尔莫妮娅 · 网上找话题（主人私有）' });
        await writeJson(stateFile, { sessionId });
      }
      await scheduleNext();
    });
    return () => { disposed = true; };
  });
}
