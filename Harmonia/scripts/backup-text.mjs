import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CACHE } from '../lib/config.mjs';

const extensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function backupText({ root = path.resolve(ROOT, '..'), destination = 'D:/Backup/QQbot' } = {}) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  if (destination === root || destination.startsWith(root + path.sep)) throw new Error('Backup destination must be outside the source project');
  const files = new Set();
  const add = relative => { if (existsSync(path.join(root, relative))) files.add(relative.replaceAll('\\', '/')); };
  const scan = relative => {
    if (!existsSync(path.join(root, relative))) return;
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) scan(child);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) add(child);
    }
  };
  for (const required of ['Harmonia/config/PERSONA.md', 'Harmonia/memory/memories.json']) {
    if (!existsSync(path.join(root, required))) throw new Error(`Required source is missing: ${required}`);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && ['.md', '.txt'].includes(path.extname(entry.name).toLowerCase())) add(entry.name);
  }
  for (const dir of ['Harmonia/memory', 'Harmonia/research', 'Harmonia/skills', 'Harmonia/runtime/sessions', 'Harmonia/docs', '旧bot人设文档']) scan(dir);
  for (const entry of readdirSync(path.join(root, 'Harmonia/config'), { withFileTypes: true })) {
    if (entry.isFile() && ['.md', '.txt'].includes(path.extname(entry.name).toLowerCase())) add(`Harmonia/config/${entry.name}`);
  }
  for (const file of ['Harmonia/VALIDATION.md', 'Harmonia/runtime/dsh-sessions.json', 'Harmonia/runtime/proactive-scheduler.json', 'Harmonia/runtime/memory-prompt.json', 'Harmonia/runtime/context-resets.json',
    'Harmonia/scripts/backup-text.mjs', 'Harmonia/scripts/install-text-backup.ps1', 'Harmonia/scripts/run-hidden.vbs']) add(file);

  const contents = new Map(), hashes = {};
  for (const relative of [...files].sort()) {
    const bytes = readFileSync(path.join(root, relative));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (path.extname(relative) === '.json') JSON.parse(text.replace(/^\uFEFF/, ''));
    contents.set(relative, bytes);
    hashes[relative] = hash(bytes);
  }
  const snapshots = path.join(destination, 'snapshots');
  mkdirSync(snapshots, { recursive: true });
  // Only manifest-bearing directories are complete; interrupted copies are never accepted.
  let previousDir, previousManifest;
  for (const name of readdirSync(snapshots).sort().reverse()) {
    const manifest = path.join(snapshots, name, 'manifest.json');
    if (!existsSync(manifest)) continue;
    try { previousManifest = JSON.parse(readFileSync(manifest, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (!previousManifest?.sha256) continue;
    previousDir = path.join(snapshots, name);
    break;
  }
  const unchanged = Boolean(previousDir && JSON.stringify(previousManifest.sha256) === JSON.stringify(hashes)
    && [...contents].every(([file]) => existsSync(path.join(previousDir, file)) && hash(readFileSync(path.join(previousDir, file))) === hashes[file]));
  let snapshot = previousDir;
  if (!unchanged) {
    snapshot = path.join(snapshots, new Date().toISOString().replaceAll(':', '-').replace('Z', '') + '-' + randomUUID().slice(0, 8));
    for (const [relative, bytes] of contents) {
      const target = path.join(snapshot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      if (hash(readFileSync(target)) !== hashes[relative]) throw new Error(`Backup verification failed: ${relative}`);
    }
    writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), source: root, sha256: hashes }, null, 2));
  }
  const status = { checkedAt: new Date().toISOString(), status: 'ok', changed: !unchanged, files: files.size, snapshot };
  writeFileSync(path.join(destination, 'last-run.json'), JSON.stringify(status, null, 2));
  writeFileSync(path.join(destination, 'CURRENT.txt'), snapshot + '\r\n');
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(backupText())); }
  catch (error) {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(path.join(CACHE, 'text-backup-error.log'), `${new Date().toISOString()} ${error.message}\n`);
    console.error('Text backup failed; inspect .cache/harmonia/text-backup-error.log');
    process.exitCode = 1;
  }
}
