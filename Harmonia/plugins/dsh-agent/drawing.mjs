import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { drawMeme, MOTIONS, ICONS } from '../../lib/draw-meme.mjs';

export const name = 'harmonia-drawing';
export const inject = ['tools'];
export async function apply(ctx, config) {
  const require = createRequire(path.join(os.homedir(), '.dsh/profiles/web/package.json'));
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  let pending = 0;
  ctx.tools.register(defineTool({
    name: 'draw_meme', description: '直接绘制并导出原创GIF表情，不调用Codex。先加载pixel-gif-sticker-pack技能；提供自包含SVG角色画面、中文短句、动作和点缀。成功后最终JSON的sticker填返回的sticker路径；工具不会直接发消息。',
    timeoutMs: 60000,
    parameters: {
      svg: { type: 'string', required: true, description: '完整SVG，320x320透明画面，无文字、外链或嵌入图片，主体下方留文字空间。' },
      caption: { type: 'string', required: true, description: '1到24字的表情短句。' },
      meaning: { type: 'string', required: true, description: '画面内容、情绪含义、适用场景与关键词，最多300字。' },
      motion: { type: 'string', required: true, enum: MOTIONS },
      icon: { type: 'string', required: true, enum: ICONS },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('Drawing cancelled');
      if (pending >= 2) throw new Error('Drawing is busy');
      pending++;
      try { return await drawMeme(args, { root: config.root, cache: path.resolve(config.root, '../.cache/harmonia') }); }
      finally { pending--; }
    },
  }));
}
