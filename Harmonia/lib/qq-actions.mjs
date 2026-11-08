import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';
import { notifyAliveChat } from './alive-chat.mjs';

export const QQ_ACTION_TOOLS = ['qq_poke', 'qq_qzone', 'qq_share'];
function text(value, max, required = true) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw new Error('Invalid QQ action text');
  return value.trim();
}
function url(value) {
  const parsed = new URL(text(value, 4096));
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid share URL');
  return parsed.href;
}
export function qqActionRequest(tool, args, config) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid QQ action arguments');
  if (tool === 'qq_poke') return { action: 'send_poke', params: { user_id: Number(config.ownerQQ) }, effect: true };
  if (tool === 'qq_share') return { action: 'send_tuwen_ark', effect: true, params: {
    user_id: Number(config.ownerQQ), title: text(args.title, 300), jump_url: url(args.jump_url),
    desc: text(args.desc ?? args.title, 1500), summary: text(args.summary ?? '[分享]', 100),
    ...(args.preview_url ? { preview_url: url(args.preview_url) } : {}),
  } };
  if (tool !== 'qq_qzone' || !['list', 'detail', 'feeds'].includes(args.action)) throw new Error('QQ action is not allowed');
  const num = args.num ?? 10, pos = args.pos ?? 0;
  if (!Number.isInteger(num) || num < 1 || num > 100 || !Number.isInteger(pos) || pos < 0) throw new Error('Invalid Qzone page');
  if (args.action === 'feeds') return { action: 'get_qzone_feeds', params: { page_num: 1, count: num } };
  const uin = args.uin === 'me' ? config.botQQ : args.uin ?? config.ownerQQ;
  if (typeof uin !== 'string' || !/^\d{5,12}$/.test(uin)) throw new Error('Invalid Qzone owner');
  return { action: args.action === 'list' ? 'get_qzone_msg_list' : 'get_qzone_msg_detail', params: {
    target_uin: Number(uin), pos, num, ...(args.action === 'detail' ? { tid: text(args.tid, 256) } : {}),
  } };
}
export async function executeQQAction(request, config, call) {
  const sessions = await readJson(path.join(config.root, 'runtime/dsh-sessions.json'), {});
  if (!request.sessionId || !Object.entries(sessions).some(([scope, id]) => id === request.sessionId
    && (scope === 'owner-private' || /^qq-group-\d+:owner-mention$/.test(scope)))) throw new Error('QQ actions require an owner session');
  const operation = qqActionRequest(request.tool, request.args, config);
  let receipt;
  if (operation.effect) {
    const id = text(request.requestId, 200);
    const key = createHash('sha256').update(`${request.sessionId}:${id}`).digest('hex');
    receipt = path.join(config.root, 'runtime/qq-actions', `${key}.json`);
    await mkdir(path.dirname(receipt), { recursive: true });
    let handle;
    try { handle = await open(receipt, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return (await readJson(receipt, {})).result ?? { ok: false, note: '发送状态不确定，未重发。' };
    }
    try { await handle.writeFile(JSON.stringify({ state: 'processing', at: Date.now() })); }
    finally { await handle.close(); }
  }
  try {
    const data = await call(operation.action, operation.params);
    const result = { ok: true, data };
    if (receipt) await writeJson(receipt, { state: 'completed', at: Date.now(), result });
    if (request.tool === 'qq_share') await notifyAliveChat(config, { type: 'sent', id: `qq-share:${path.basename(receipt, '.json')}`,
      text: `[分享卡片] ${operation.params.title}\n${operation.params.jump_url}` });
    return result;
  } catch (error) {
    if (!receipt) throw error;
    const result = { ok: false, note: '发送失败或状态不确定，未自动重发。' };
    await writeJson(receipt, { state: 'failed-or-uncertain', at: Date.now(), result });
    return result;
  }
}
