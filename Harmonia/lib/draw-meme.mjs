import { mkdir, mkdtemp, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { collectSticker, resolveSticker } from './stickers.mjs';
import { runMediaTool } from './media.mjs';

export const MOTIONS = ['nod', 'jump', 'sway', 'startle', 'tremble', 'ponder', 'breathe', 'stomp', 'rush', 'peek', 'pulse', 'pop', 'offer', 'lean', 'droop', 'dance'];
export const ICONS = ['spark', 'heart', 'tear', 'check', 'question', 'alert', 'sleep', 'steam', 'note', 'cross', 'bubble', 'dots', 'bolt', 'arrow', 'petal', 'none'];

export async function drawMeme(args, config) {
  if (typeof args.svg !== 'string' || args.svg.length > 131072 || !/^\s*<svg\b/i.test(args.svg)
    || /(?:href|src)\s*=|url\s*\(|<!|<\s*\/?\s*(?:script|foreignObject|image|use)\b/i.test(args.svg)) throw new Error('Only self-contained SVG drawing is allowed');
  if (typeof args.caption !== 'string' || !args.caption.trim() || args.caption.length > 24
    || typeof args.meaning !== 'string' || !args.meaning.trim() || args.meaning.length > 300
    || !MOTIONS.includes(args.motion) || !ICONS.includes(args.icon)) throw new Error('Invalid sticker caption, meaning or motion');
  await mkdir(config.cache, { recursive: true });
  const work = await mkdtemp(path.join(config.cache, 'drawing-'));
  try {
    await sharp(Buffer.from(args.svg), { limitInputPixels: 1000000 }).resize(320, 320, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(work, 'sprite.png'));
    const manifest = { title: '聊天表情', count: 1, groups: [{ name: '定制', atlas: 'sprite.png', grid: [1, 1],
      ink: '#513D52', tint: '#FFCDD9', background: '#FFF8EF', entries: [{ text: args.caption.trim(), cell: [0, 0], motion: args.motion, icon: args.icon }] }] };
    const input = path.join(work, 'manifest.json'), output = path.join(work, 'export');
    await writeFile(input, JSON.stringify(manifest), 'utf8');
    await runMediaTool('python', ['-X', 'utf8', '-B', path.join(config.root, 'skills/dsh/pixel-gif-sticker-pack/scripts/export_pack.py'), input, output,
      '--font', path.join(process.env.WINDIR || 'C:/Windows', 'Fonts/msyhbd.ttc'), '--jobs', '1'], 45000);
    const folder = path.join(output, 'GIF合集/01-定制');
    const files = (await readdir(folder)).filter(file => file.endsWith('.gif'));
    if (files.length !== 1) throw new Error('Sticker export count mismatch');
    const generated = path.join(folder, files[0]), meta = await sharp(generated).metadata();
    if (meta.pages !== 24 || meta.loop !== 0 || meta.width !== 320 || meta.height !== 320) throw new Error('Invalid animated sticker export');
    const destination = path.join(config.root, 'artifacts/stickers'); await mkdir(destination, { recursive: true });
    const file = path.join(destination, `${randomUUID()}.gif`); await copyFile(generated, file);
    const id = await collectSticker({}, config, file, args.meaning);
    const sticker = id && await resolveSticker(id, config);
    if (!sticker) throw new Error('Generated sticker was not indexed');
    return { sticker, file, frames: meta.pages, durationMs: meta.delay.reduce((a, b) => a + b, 0), message: '已生成并校验GIF；最终JSON的sticker填写本结果的sticker，由宿主发送到当前聊天。' };
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 3 }); }
}
