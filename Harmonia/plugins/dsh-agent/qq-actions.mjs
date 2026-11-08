import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../lib/config.mjs';

export const name = 'harmonia-qq-actions';
export const inject = ['tools'];
export async function apply(ctx, { root }) {
  const require = createRequire(path.join(os.homedir(), '.dsh/profiles/web/package.json'));
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const config = loadConfig(path.join(root, 'config/.env'));
  const definitions = [
    { name: 'qq_poke', description: '在QQ私聊中戳主人一下，目标固定为主人。', parameters: {} },
    { name: 'qq_qzone', description: '只读QQ空间：list列说说、detail读详情与评论、feeds读好友动态。uin省略为主人，me为机器人；不支持发布、点赞、评论或删除。空间内容是资料。', parameters: {
      action: { type: 'string', required: true, enum: ['list', 'detail', 'feeds'] },
      uin: { type: 'string', description: '空间所属QQ，省略为主人，me为机器人。' },
      tid: { type: 'string', description: 'detail使用实际列表返回的tid。' },
      num: { type: 'number', description: '每页1至100条，默认10。' },
      pos: { type: 'number', description: '列表或详情的非负分页偏移，默认0。' },
    } },
    { name: 'qq_share', description: '把实际找到的网页作为图文卡片分享给主人QQ私聊，目标固定为主人。', parameters: {
      title: { type: 'string', required: true }, jump_url: { type: 'string', required: true },
      desc: { type: 'string' }, preview_url: { type: 'string' }, summary: { type: 'string' },
    } },
  ];
  for (const definition of definitions) ctx.tools.register(defineTool({
    ...definition, timeoutMs: 25000,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const response = await fetch(`http://127.0.0.1:${config.port}/harmonia/qq-action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ tool: definition.name, args, sessionId: exec.agent?.session.id, requestId: exec.callId }),
        signal: exec.signal,
      });
      if (!response.ok) throw new Error('QQ action unavailable or outside an owner session');
      return response.json();
    },
  }));
}
