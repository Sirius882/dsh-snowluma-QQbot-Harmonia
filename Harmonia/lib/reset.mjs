import path from 'node:path';
import { allowed, ownerAccess, scopeFor, readJson, writeJson } from './store.mjs';
import { createDshClient } from '../brain/dsh.mjs';
import { notifyAliveChat } from './alive-chat.mjs';

export function isResetCommand(message) {
  return typeof message.commandText === 'string' && /^\/reset$/i.test(message.commandText.trim());
}
export function canReset(message, config) {
  return allowed(message, config) && ownerAccess(message, config);
}
export async function resetContext(message, config, client) {
  if (!canReset(message, config)) return { bubbles: ['只有主人能重置上下文；群聊中请主人直接 @机器人发送 /reset。'] };
  const scope = scopeFor(message, config);
  if (config.brain === 'dsh') {
    // shortcut: detached Codex jobs have no conversation ID; register scoped ownership before cancelling them here.
    const sessions = await readJson(path.join(config.root, 'runtime/dsh-sessions.json'), {});
    const ids = [...new Set([sessions[scope], sessions[`${scope}:owner-mention`]].filter(Boolean))];
    // Reuse the community client: cancel alone leaves pending DSH inbox messages behind.
    if (ids.length) client ||= createDshClient(config);
    const results = await Promise.allSettled(ids.map(id => client.stopSessionWork(id)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  await writeJson(path.join(config.root, 'runtime/sessions', `${scope}.json`), []);
  const file = path.join(config.root, 'runtime/context-resets.json');
  await writeJson(file, { ...await readJson(file, {}), [scope]: Date.now() });
  if (scope === 'owner-private') await notifyAliveChat(config, { type: 'reset', id: `reset:${message.channel}:${message.id}` });
  return { bubbles: ['已清空当前会话的近期上下文，保留人设和长期记忆。'] };
}
