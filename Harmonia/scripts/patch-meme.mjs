import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/config.mjs';

export function patchMemeStore(source) {
  for (const signature of ['list(tag, query, exact = false)', 'search(query, n = 8, tag = null)']) {
    const before = `${signature} {`;
    const after = `${signature} {\n    this.refresh() // Harmonia and native tools share this index across processes.`;
    if (source.includes(after)) continue;
    if (!source.includes(before)) throw new Error('dsh-meme store layout changed');
    source = source.replace(before, after);
  }
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.join(os.homedir(), '.dsh/profiles/web/node_modules/dsh-meme');
  const file = path.join(root, 'memes.js');
  await writeFile(file, patchMemeStore(await readFile(file, 'utf8')));
  const entry = path.join(root, 'index.js');
  let source = (await readFile(entry, 'utf8')).replaceAll('\r\n', '\n');
  const old = `const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000), redirect: 'follow' })\n            if (!res.ok) return { ok: false, message: '下载失败: HTTP ' + res.status }\n            const ctype = String(res.headers.get('content-type') || '')`;
  const replacement = `const { safeFetchBuffer } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'vendor/qq-bridge/src/safe-fetch.js')).href)})\n            const { buffer: imageBytes } = await safeFetchBuffer(imageUrl, 8 * 1024 * 1024)\n            const ctype = String(sniffImageMime(imageBytes) || '')`;
  if (source.includes(old)) {
    source = source.replace(old, replacement).replace('buf = Buffer.from(await res.arrayBuffer())', 'buf = imageBytes');
    await writeFile(entry, source);
  } else if (!source.includes('const { buffer: imageBytes }')) throw new Error('dsh-meme image download layout changed');
  console.log('Patched dsh-meme: shared index refresh and bounded safe image downloads.');
}
