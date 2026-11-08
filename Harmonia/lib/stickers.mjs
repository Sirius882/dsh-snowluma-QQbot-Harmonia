import { readdir, mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './store.mjs';
import { sanitizeStickerText } from '../vendor/qq-bridge/src/sticker-lib.js';
import sharp from 'sharp';

export const memeModule = () => import(pathToFileURL(path.join(process.env.USERPROFILE, '.dsh/profiles/web/node_modules/dsh-meme/memes.js')).href);
export async function stickerRows(config) {
  const native = await memeModule();
  const settings = await readJson(path.join(native.dshHome(), '.dsh/dsh-expression.json'), {});
  const root = directory(config);
  const packs = native.scanPacks(settings.packsDir || native.defaultPacksDir());
  if (!packs.some(pack => path.resolve(pack.path) === path.resolve(root))) packs.unshift({ id: '_custom', path: root });
  const enabled = native.enabledPackIds(settings, packs, '_custom');
  const rows = [];
  for (const pack of packs.filter(pack => enabled.includes(pack.id))) {
    if (!await stat(path.join(pack.path, 'index.db')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) continue;
    const store = new native.MemesStore(pack.path);
    for (const row of store.list().memes) {
      const file = path.resolve(pack.path, row.path);
      if (file.startsWith(path.resolve(pack.path) + path.sep) && /\.(png|jpe?g|gif|webp)$/i.test(file)) rows.push({ ...row, path: file });
    }
  }
  return rows;
}

export async function initializeStickerIndex(config) {
  const dir = directory(config); await mkdir(dir, { recursive: true });
  const { openIndexWriter } = await memeModule();
  const db = openIndexWriter(dir);
  try { db.exec('CREATE TABLE IF NOT EXISTS memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT, mtime REAL, captioned_at REAL)'); }
  finally { db.close(); }
}

const VALID = /^[\p{L}\p{N}_-]+\.(png|jpe?g|gif|webp)$/iu;
function directory(config) {
  return path.join(config.root, 'assets/stickers/shared');
}
export async function collectSticker(message, config, file, caption = '表情包') {
  let bytes = await readFile(file);
  if (bytes.length > 2 * 1024 * 1024) bytes = await sharp(bytes, { animated: true, limitInputPixels: 100000000 })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75, effort: 2 }).toBuffer();
  if (bytes.length > 2 * 1024 * 1024) return null;
  const dir = directory(config); await initializeStickerIndex(config);
  const ext = bytes[0] === 0x89 ? 'png' : bytes[0] === 0xff ? 'jpg' : bytes[0] === 0x47 ? 'gif' : 'webp';
  const name = createHash('sha256').update(bytes).digest('hex').slice(0, 24) + '.' + ext;
  await writeFile(path.join(dir, name), bytes);
  const { openIndexWriter } = await memeModule();
  const db = openIndexWriter(dir), meaning = sanitizeStickerText(caption, 200);
  try { db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET caption=excluded.caption, keywords=excluded.keywords, captioned_at=excluded.captioned_at')
    .run(name, 'daily', name, meaning, meaning, Date.now(), Date.now()); }
  finally { db.close(); }
  return name;
}
export async function stickerCatalog(message, config) {
  const root = path.join(config.root, 'assets/stickers');
  const catalog = {};
  for (const name of (await readdir(root)).filter(x => VALID.test(x))) catalog[name] = { file: path.join(root, name), caption: name };
  const dir = directory(config);
  let rows = await stickerRows(config);
  // Use dsh-meme's existing tokenizer/ranking for contextual recall; the model still chooses whether to send.
  if (rows.length) {
    const module = await memeModule();
    const result = module.searchRows(rows, message.text || '', 24);
    rows = result.memes?.length ? result.memes : rows.slice(-24);
  }
  for (const row of rows) {
    const id = path.dirname(row.path) === dir ? path.basename(row.path) : row.path;
    catalog[id] = { file: row.path, caption: row.caption };
  }
  return catalog;
}
export async function learnIncomingStickers(message, response, config) {
  const notes = response.learnStickers;
  if (!Array.isArray(notes)) return;
  for (const note of notes.slice(0, 3)) {
    if (!Number.isInteger(note?.image) || !message.images?.[note.image - 1] || typeof note.caption !== 'string' || !note.caption.trim()) continue;
    await collectSticker(message, config, message.images[note.image - 1], note.caption);
  }
}

export async function resolveSticker(name, config) {
  if (typeof name !== 'string' || !name) return '';
  const root = path.join(config.root, 'assets/stickers');
  const row = (await stickerRows(config)).find(row => row.path === name || path.dirname(row.path) === directory(config) && path.basename(row.path) === name);
  const manual = path.isAbsolute(name) && path.dirname(name) === root && VALID.test(path.basename(name)) ? name : '';
  const file = row?.path || manual || (VALID.test(name) ? path.join(root, name) : '');
  if (!file) return '';
  const resolved = await realpath(file).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (resolved !== path.resolve(file)) return '';
  return await stat(file).then(value => value.isFile() ? file : '', error => { if (error.code === 'ENOENT') return ''; throw error; });
}
