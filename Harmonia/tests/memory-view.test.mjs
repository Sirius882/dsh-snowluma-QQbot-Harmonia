import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { writeJson } from '../lib/store.mjs';
import { advanceMemoryView, materializeMemory, getMemoryView, memoryDeltaText, MEMORY_MERGE_CHANGES, MEMORY_DELTA_MAX_BYTES } from '../lib/memory-view.mjs';

const row = (id, text = id) => ({ id, text, source: { channel: 'qq', kind: 'private' } });
const base = () => ({ version: 2, facts: [row('base')], todos: [] });

test('new memories append to the delta while the snapshot remains byte-identical', () => {
  const memory = base(), first = advanceMemoryView(null, memory), snapshot = JSON.stringify(first.snapshot);
  memory.facts.push(row('new'));
  const second = advanceMemoryView(first, memory);
  assert.equal(JSON.stringify(second.snapshot), snapshot); assert.equal(second.delta.length, 1);
  assert.deepEqual(materializeMemory(second).facts.map(item => item.id).sort(), ['base', 'new']);
  assert.match(memoryDeltaText(second), /new/);
  memory.todos.push({ ...row('task'), done: false });
  const third = advanceMemoryView(second, memory);
  memory.todos[0].done = true;
  const fourth = advanceMemoryView(third, memory);
  assert.equal(fourth.delta.length, 3); assert.equal(materializeMemory(fourth).todos[0].done, true);
});

test('formatting, object key order and entry order do not rewrite a memory snapshot', () => {
  const memory = base(); memory.facts.push(row('another'));
  const first = advanceMemoryView(null, memory);
  const reordered = { todos: [], facts: memory.facts.reverse().map(item => ({ source: { kind: 'private', channel: 'qq' }, text: item.text, id: item.id })), version: 2 };
  assert.equal(advanceMemoryView(first, reordered), first);
});

test('text corrections and forgetting rebuild immediately without retaining removed original text', () => {
  const memory = base(), first = advanceMemoryView(null, memory);
  memory.facts[0].text = 'CORRECTED';
  const corrected = advanceMemoryView(first, memory);
  assert.equal(corrected.delta.length, 0); assert.equal(corrected.snapshot.facts[0].text, 'CORRECTED');
  memory.facts = [];
  const forgotten = advanceMemoryView(corrected, memory);
  assert.doesNotMatch(JSON.stringify(forgotten), /CORRECTED/);
  memory.facts.push(row('pending', 'DELETE_PENDING'));
  const pending = advanceMemoryView(forgotten, memory);
  memory.facts = [];
  assert.doesNotMatch(JSON.stringify(advanceMemoryView(pending, memory)), /DELETE_PENDING/);
});

test('delta count and byte limits merge a new stable snapshot', () => {
  const memory = base(); let view = advanceMemoryView(null, memory);
  for (let i = 0; i < MEMORY_MERGE_CHANGES; i++) {
    memory.facts.push(row(`new-${i}`)); view = advanceMemoryView(view, memory);
  }
  assert.equal(view.delta.length, 0); assert.equal(view.snapshot.facts.length, MEMORY_MERGE_CHANGES + 1);
  memory.facts.push(row('large', 'x'.repeat(MEMORY_DELTA_MAX_BYTES)));
  assert.equal(advanceMemoryView(view, memory).delta.length, 0);
});

test('snapshot state survives reload, regenerates from the one authority and never edits that authority', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'memory-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { root }, memory = base(), file = path.join(root, 'memory/memories.json');
  await writeJson(file, memory);
  const first = getMemoryView(config); memory.facts.push(row('new')); await writeJson(file, memory);
  const second = getMemoryView(config);
  assert.deepEqual(second.snapshot, first.snapshot); assert.equal(second.delta.length, 1);
  assert.deepEqual(getMemoryView(config), second);
  const original = await readFile(file, 'utf8');
  await writeFile(path.join(root, 'runtime/memory-prompt.json'), 'broken derived state');
  assert.deepEqual(getMemoryView(config).snapshot, materializeMemory(second));
  assert.equal(await readFile(file, 'utf8'), original);
  assert.throws(() => advanceMemoryView(null, { facts: [row('dup'), row('dup')], todos: [] }), /Duplicate/);
  assert.throws(() => advanceMemoryView(null, { facts: 'bad', todos: [] }), /collection/);
});
