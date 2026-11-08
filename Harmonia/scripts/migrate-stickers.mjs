import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/config.mjs';
import { readJson, writeJson } from '../lib/store.mjs';
import { collectSticker, stickerRows, initializeStickerIndex } from '../lib/stickers.mjs';

export async function migrateStickers(config) {
  const marker = path.join(config.root, 'assets/stickers/shared/legacy-imported.json');
  if (await readJson(marker, false)) return 0;
  const scopes = path.join(config.root, 'assets/stickers/scopes');
  const dirs = await readdir(scopes, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  await initializeStickerIndex(config);
  const shared = Object.fromEntries((await stickerRows(config)).map(row => [path.basename(row.path), true]));
  const sharedFolder = path.join(config.root, 'assets/stickers/shared');
  const sources = [sharedFolder, ...dirs.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(dir => path.join(scopes, dir.name))];
  let count = 0;
  for (const folder of sources) {
    const index = await readJson(path.join(folder, 'index.json'), {});
    for (const [name, row] of Object.entries(index)) {
      if (!/^[\p{L}\p{N}_-]+\.(png|jpe?g|gif|webp)$/iu.test(name)) throw new Error('Invalid legacy sticker filename');
      const bytes = await readFile(path.join(folder, name));
      const existing = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      if (Object.keys(shared).some(file => file.startsWith(existing + '.'))) continue;
      const id = await collectSticker({}, config, path.join(folder, name), row.caption);
      if (!id) throw new Error('Legacy sticker could not be imported');
      shared[id] = true;
      count++;
    }
  }
  await writeJson(marker, { completedAt: new Date().toISOString() });
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Merged ${await migrateStickers({ root: ROOT })} legacy sticker entries into the shared library; originals retained.`);
}
