import { mkdir, readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/config.mjs';
import { EMPTY_MEMORY, memoryFile, readJson, writeJson } from '../lib/store.mjs';

export async function migrateMemory(config) {
  if (await readJson(memoryFile(config), null)) return false;
  const memory = structuredClone(EMPTY_MEMORY);
  const add = (value, key, source, file) => {
    const row = typeof value === 'string' ? { text: value } : value;
    if (typeof row?.text !== 'string') throw new Error('Invalid legacy memory entry');
    const origin = { ...source, file, ...(typeof row.source === 'string' ? { channel: row.source } : row.source) };
    memory[key].push({ ...row, id: row.id || createHash('sha256').update(JSON.stringify([origin, key, row.text])).digest('hex').slice(0, 24), source: origin });
  };
  const owner = await readJson(path.join(config.root, 'memory/owner_memory.json'), { facts: [], todos: [] });
  for (const key of ['facts', 'todos']) for (const row of owner[key] || []) add(row, key, { kind: 'private', contact: 'owner' }, 'owner_memory.json');
  const groups = await readJson(path.join(config.root, 'memory/group_slang.json'), { groups: {} });
  for (const [groupId, group] of Object.entries(groups.groups || {})) {
    for (const key of ['slang', 'impressions']) for (const row of group[key] || []) add(row, 'facts', { channel: 'qq', kind: 'group', groupId }, 'group_slang.json');
  }
  for (const file of ['SOURCE_INTERESTS.md', 'BILIBILI_SOURCES.md']) {
    const text = await readFile(path.join(config.root, 'memory', file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (text.trim()) add(text, 'facts', { kind: 'document' }, file);
  }
  await writeJson(memoryFile(config), memory);
  const legacy = path.join(config.root, 'memory/legacy');
  await mkdir(legacy, { recursive: true });
  for (const file of ['owner_memory.json', 'group_slang.json', 'SOURCE_INTERESTS.md', 'BILIBILI_SOURCES.md']) {
    await rename(path.join(config.root, 'memory', file), path.join(legacy, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Unified memory migration: ${await migrateMemory({ root: ROOT }) ? 'completed, originals archived' : 'already complete'}`);
}
