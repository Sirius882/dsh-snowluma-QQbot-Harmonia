import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_IMAGE_BYTES } from './images.mjs';
sharp.cache({ files: 0, memory: 32 }); // Do not retain file handles to per-turn temporary media on Windows.

export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MEDIA_TARGET_BYTES = 8 * 1024 * 1024;
export function mediaKind(bytes) {
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG' || bytes[0] === 0xff && bytes[1] === 0xd8 || /GIF8/.test(bytes.subarray(0, 4).toString()) || bytes.subarray(8, 12).toString() === 'WEBP') return 'image';
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 || bytes.subarray(8, 12).toString() === 'WAVE' || bytes.subarray(0, 4).toString() === 'fLaC' || bytes.subarray(0, 4).toString() === 'OggS' || bytes.subarray(0, 6).toString().includes('SILK')) return 'audio';
  if (bytes.subarray(4, 8).toString() === 'ftyp' || bytes[0] === 0x1a && bytes[1] === 0x45 || bytes.subarray(8, 12).toString() === 'AVI ') return 'video';
  return null;
}
export function runMediaTool(command, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Media conversion timeout')); }, timeout);
    child.stdout.on('data', d => { if (output.length < 65536) output += d; });
    child.stderr.resume(); child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('Media conversion failed')); });
  });
}
export async function compressMedia(file, config, limit = MAX_IMAGE_BYTES) {
  const size = (await stat(file)).size;
  const handle = await import('node:fs/promises').then(fs => fs.open(file, 'r'));
  const header = Buffer.alloc(16); try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
  const kind = mediaKind(header);
  if (kind && kind !== 'image') limit = Math.min(limit, MEDIA_TARGET_BYTES);
  if (!kind || size <= limit) return { file, kind, compressed: false, bytes: size };
  if (size > MAX_DOWNLOAD_BYTES) throw new Error('Media download ceiling exceeded');
  const dir = path.join(config.cache, 'media'); await mkdir(dir, { recursive: true });
  const started = performance.now();
  let result;
  if (kind === 'image') {
    // libvips does resize/encode in native worker threads. One decode, bounded pixels and a single output pass.
    const bytes = await sharp(file, { animated: true, limitInputPixels: 100000000, sequentialRead: true })
      .rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 2 }).toBuffer();
    result = path.join(dir, `${randomUUID()}.webp`); await writeFile(result, bytes);
  } else {
    const info = JSON.parse(await runMediaTool(config.ffprobe || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-of', 'json', file], 5000));
    const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Media duration unavailable or too long');
    result = path.join(dir, `${randomUUID()}.${kind === 'audio' ? 'mp3' : 'mp4'}`);
    const kbps = Math.floor(MEDIA_TARGET_BYTES * 8 / duration / 1000 * 0.90);
    if (kbps < (kind === 'audio' ? 24 : 150)) throw new Error('Media cannot fit readable bitrate');
    const encode = kind === 'audio' ? ['-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', `${Math.min(64, kbps)}k`]
      : ['-vf', "scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${Math.min(900, kbps - 48)}k`, '-maxrate', `${Math.min(1100, kbps - 48)}k`, '-bufsize', '512k', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-ar', '24000', '-movflags', '+faststart'];
    await runMediaTool(config.ffmpeg || 'ffmpeg', ['-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-map_metadata', '-1', '-threads', '2', ...encode, result], kind === 'audio' ? 20000 : 30000);
  }
  const bytes = (await stat(result)).size;
  if (!bytes || bytes > Math.min(limit, MEDIA_TARGET_BYTES)) throw new Error('Compressed media still too large');
  return { file: result, kind, bytes, originalBytes: size, compressed: true, elapsedMs: Math.round(performance.now() - started) };
}
export async function fitImageBatch(message, config) {
  message.visionImages = [];
  for (const [index, file] of (message.images || []).entries()) {
    const generated = [];
    try {
      const meta = await sharp(file, { limitInputPixels: 100000000 }).metadata();
      if (!(meta.pages > 1)) {
        message.visionImages.push(file);
        message.text += `\n[原图片 ${index + 1} 对应随附图片 ${message.visionImages.length}]`;
        continue;
      }
      if (meta.pages > 512) throw new Error('Animation exceeds frame budget');
      // Decode once with libvips, then expose every frame as ordered static contact sheets.
      const { data, info } = await sharp(file, { animated: true, limitInputPixels: 100000000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const height = info.height / meta.pages, stride = info.width * height * info.channels;
      const tile = 256, label = 24, perSheet = 16;
      let elapsed = 0;
      const dir = path.join(config.cache, 'media'); await mkdir(dir, { recursive: true });
      for (let start = 0; start < meta.pages; start += perSheet) {
        const count = Math.min(perSheet, meta.pages - start), layers = [];
        for (let offset = 0; offset < count; offset++) {
          const frame = start + offset, left = offset % 4 * tile, top = Math.floor(offset / 4) * (tile + label);
          const input = await sharp(data.subarray(frame * stride, (frame + 1) * stride), { raw: { width: info.width, height, channels: info.channels } })
            .resize(tile, tile, { fit: 'contain', background: 'white' }).png().toBuffer();
          const caption = Buffer.from(`<svg width="256" height="24"><rect width="256" height="24" fill="white"/><text x="6" y="18" font-size="15" fill="black">#${frame + 1} @ ${elapsed}ms (+${meta.delay?.[frame] ?? 100}ms)</text></svg>`);
          layers.push({ input, left, top }, { input: caption, left, top: top + tile });
          elapsed += meta.delay?.[frame] ?? 100;
        }
        const output = path.join(dir, `${randomUUID()}.webp`);
        (message.cleanup ||= []).push(output);
        await sharp({ create: { width: tile * 4, height: Math.ceil(count / 4) * (tile + label), channels: 3, background: 'white' } })
          .composite(layers).webp({ quality: 85, effort: 2 }).toFile(output);
        generated.push(output);
      }
      const first = message.visionImages.length + 1;
      message.visionImages.push(...generated);
      message.text += `\n[图片 ${index + 1} 是动图：共 ${meta.pages} 帧、${elapsed}ms；随附 ${generated.length} 张逐帧拼图（随附图片编号 ${first}–${message.visionImages.length}），按从左到右、从上到下阅读，标签为原帧号和时间，已提供全部帧。收藏表情时仍用原图片编号 ${index + 1}，不要收藏拼图。]`;
    } catch {
      message.visionImages.push(file);
      message.text += `\n[图片 ${index + 1} 无法展开或解析；若是动图，本轮只能看到封面，不要声称看过完整动作。]`;
    }
  }
  const sizes = await Promise.all(message.visionImages.map(file => stat(file).then(value => value.size)));
  if (sizes.reduce((a, b) => a + b, 0) <= MAX_IMAGE_BYTES) return;
  const limit = Math.floor(MAX_IMAGE_BYTES / sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    const old = message.visionImages[i];
    const result = await compressMedia(old, config, limit);
    (message.cleanup ||= []).push(result.file); message.visionImages[i] = result.file;
  }
}
