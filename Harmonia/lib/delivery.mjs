import path from 'node:path';
import { rm } from 'node:fs/promises';
import { readJson, writeJson, scopeFor } from './store.mjs';
import { reviewGroup } from '../brain/moderation.mjs';
import { recentMessage } from './history.mjs';
import { isResetCommand, canReset, resetContext } from './reset.mjs';
import { notifyAliveChat } from './alive-chat.mjs';

export function brainFailureNotice(code) {
  if (code === 'DSH_CONTEXT_OVERFLOW') return '这段会话积累的内容太多了，上下文已超限，这次没能完成回复。需要整理历史后再继续。';
  if (['DSH_IDLE_TIMEOUT', 'DSH_TURN_TIMEOUT'].includes(code)) return '这次回复等太久，已经超时停止了，暂时没能答上来。稍后再发我一句吧。';
  if (code === 'DSH_BUSY') return '模型服务现在繁忙，这条暂时没能回复。稍后再发我一句吧。';
  return '这次推理出了点问题，暂时没能回复。稍后再发我一句吧。';
}

export function createDelivery(config, route, status, { review = (message, history) => reviewGroup(message, config, fetch, history), reset = message => resetContext(message, config) } = {}) {
  let queue = Promise.resolve(), pending = 0;
  const jobs = new Map();
  const file = path.join(config.root, 'runtime/receipts.json');
  return (message, transport) => {
    if (!recentMessage(message)) return Promise.resolve();
    const key = `${message.channel}:${message.kind}:${message.groupId || message.userId}:${message.id}`;
    if (jobs.has(key)) return jobs.get(key).result;
    const command = isResetCommand(message), authorizedReset = command && canReset(message, config);
    if (pending >= 50 && !authorizedReset) return Promise.reject(new Error('Delivery queue full'));
    pending++;
    const controller = new AbortController(), scope = scopeFor(message, config);
    const previous = [...jobs.values()].filter(job => job.scope === scope);
    // Check durable dedup before interrupting: a replayed reset must not cancel a newer turn.
    const interrupt = authorizedReset ? readJson(file, {}).then(receipts => {
      if (!receipts[key]) for (const job of previous) job.controller.abort();
    }) : Promise.resolve();
    interrupt.catch(() => {});
    const result = queue.then(async () => {
      await interrupt;
      const receipts = await readJson(file, {});
      if (receipts[key]) return;
      // Persist before any side effect. Interrupted or uncertain deliveries require a new explicit user request.
      receipts[key] = { state: 'processing', at: new Date().toISOString() };
      await writeJson(file, receipts);
      let stage = 'prepare';
      try {
        controller.signal.throwIfAborted();
        let response;
        if (command) {
          stage = 'reset';
          receipts[key].review = 'skipped-command';
          response = authorizedReset ? await reset(message) : { bubbles: ['只有主人能重置上下文；群聊中请主人直接 @机器人发送 /reset。'] };
        } else {
          await transport.prepare();
          controller.signal.throwIfAborted();
          if (message.channel === 'qq' && message.kind === 'group') {
            stage = 'moderation';
            const decision = await review(message, await transport.reviewHistory?.());
            receipts[key].review = decision.reason;
            if (!decision.approved) {
              receipts[key].state = 'blocked'; receipts[key].review = decision.reason;
              status.blocked = (status.blocked || 0) + 1;
              return;
            }
          } else receipts[key].review = 'skipped-private';
          await transport.afterReview?.();
          controller.signal.throwIfAborted();
          stage = 'brain';
          if (scope === 'owner-private') await notifyAliveChat(config, { type: 'received', id: key, text: message.text?.slice(0, 16000) || '[媒体消息]' });
          response = await route(message, { signal: controller.signal });
        }
        controller.signal.throwIfAborted();
        stage = 'send';
        await transport.send(response, { signal: controller.signal });
        receipts[key].state = 'completed';
        status.completed++;
      } catch (error) {
        if (controller.signal.aborted) { receipts[key].state = stage === 'send' ? 'failed-or-uncertain' : 'cancelled'; return; }
        receipts[key].state = 'failed-or-uncertain';
        receipts[key].failedStage = stage;
        receipts[key].errorCode = typeof error.code === 'string' && /^[\w-]{1,80}$/.test(error.code) ? error.code : error.name;
        status.failed++;
        console.error(`[${message.channel}] turn ${message.id} failed at ${stage} (${receipts[key].errorCode}); no automatic resend; npm run check`);
        if (stage === 'reset' || stage === 'brain' && message.kind === 'private') {
          // Reserve before notifying so reconnects cannot repeat even an uncertain failure notice.
          receipts[key].failureNotice = 'sending-or-uncertain';
          await writeJson(file, receipts);
          try {
            await transport.send({ bubbles: [stage === 'reset' ? '重置未完成，未能确认当前任务已停止或上下文已清空，请稍后重新发送 /reset。' : brainFailureNotice(receipts[key].errorCode)], sticker: '', _aliveFailure: true });
            receipts[key].failureNotice = 'sent';
          } catch { receipts[key].failureNotice = 'failed-or-uncertain'; }
        }
      } finally {
        await writeJson(file, receipts);
        for (const image of new Set([...(message.images || []), ...(message.cleanup || [])])) await rm(image, { force: true }).catch(() => {});
      }
    });
    jobs.set(key, { scope, controller, result });
    queue = result.catch(() => {}).finally(() => { pending--; jobs.delete(key); });
    return result;
  };
}
