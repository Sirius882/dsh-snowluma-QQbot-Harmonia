import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { readJson, writeJson, memoryFile } from '../lib/store.mjs';
import { migrateMemory } from '../scripts/migrate-memory.mjs';
import { patchMemeStore } from '../scripts/patch-meme.mjs';

test('legacy memories and source notes migrate once with provenance; originals survive and forgotten items stay forgotten', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'unified-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'memory/owner_memory.json'), { facts: [{ id: 'old-id', text: 'private', source: 'wechat', at: '2026-11-05' }], todos: [{ text: 'todo', done: false }] });
  await writeJson(path.join(root, 'memory/group_slang.json'), { groups: { '123456': { slang: ['a joke'], impressions: ['an impression'] } } });
  await writeFile(path.join(root, 'memory/SOURCE_INTERESTS.md'), 'a source note');
  const config = { root };
  assert.equal(await migrateMemory(config), true);
  const memory = await readJson(memoryFile(config));
  assert.equal(memory.facts.length, 4); assert.equal(memory.todos.length, 1);
  assert.equal(memory.facts[0].id, 'old-id'); assert.equal(memory.facts[0].source.channel, 'wechat');
  assert.equal(memory.facts.find(row => row.text === 'a joke').source.groupId, '123456');
  assert.equal(await readFile(path.join(root, 'memory/legacy/SOURCE_INTERESTS.md'), 'utf8'), 'a source note');
  memory.facts = []; await writeJson(memoryFile(config), memory);
  assert.equal(await migrateMemory(config), false);
  assert.deepEqual((await readJson(memoryFile(config))).facts, []);
});

test('native meme index refresh patch is idempotent and refuses upstream drift', () => {
  const source = 'list(tag, query, exact = false) {\n const rows = this.rows;\n}\nsearch(query, n = 8, tag = null) {\n const rows = this.rows;\n}';
  const patched = patchMemeStore(source);
  assert.equal((patched.match(/this.refresh\(\)/g) || []).length, 2);
  assert.equal(patchMemeStore(patched), patched);
  assert.throws(() => patchMemeStore('unsupported layout'), /layout changed/);
});
