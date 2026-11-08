import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function patchSource(source, core) {
  if (!source.includes('workspaceDir, workspacePermission, withLock') || /export (?:async )?function workspacePermission\b/.test(core)) return source;
  // Upstream 425f5d2 imports an absent display-only helper; its core has no workspace permission override.
  return source.replace('workspaceDir, workspacePermission, withLock', 'workspaceDir, withLock')
    .replaceAll('${workspacePermission(cfg, safeKey(chatId)) ?? "默认（跟随 DSH 全局设置）"}', '默认（跟随 DSH 全局设置）')
    .replaceAll('${workspacePermission(cfg, chat.key) ?? "默认（跟随 DSH 全局设置）"}', '默认（跟随 DSH 全局设置）');
}
export async function patchWechatLogin(root) {
  const file = path.join(root, 'vendor/wechat-bridge/weixin-bot.mjs');
  const source = await readFile(file, 'utf8');
  const patched = patchSource(source, await readFile(path.join(root, 'vendor/wechat-bridge/lib/core.mjs'), 'utf8'));
  if (patched !== source) await writeFile(file, patched, 'utf8');
}
