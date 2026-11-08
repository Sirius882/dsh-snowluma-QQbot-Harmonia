import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, OWNER_TOOLS, PUBLIC_TOOLS } from '../plugins/dsh-agent/index.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { currentTime } from '../lib/clock.mjs';
import { writeJson } from '../lib/store.mjs';
import { buildPrompt } from '../brain/unified-router.mjs';
import { ASSESSMENT_INSTRUCTION } from '../lib/alive-assessment.mjs';

test('Beijing clock includes the real weekday and changes date at local midnight', () => {
  assert.match(currentTime(Date.parse('2026-11-05T15:59:59Z')), /2026年11月5日星期四.*23:59:59/);
  assert.match(currentTime(Date.parse('2026-11-05T16:00:00Z')), /2026年11月6日星期五.*00:00:00/);
});

test('each turn pairs the stable system snapshot with its exact tail delta', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'memory-pair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config')); const personaFile = path.join(root, 'config/PERSONA.md');
  await writeFile(personaFile, 'PERSONA_PAIR');
  const file = path.join(root, 'memory/memories.json');
  const memory = { version: 2, facts: [{ id: 'base', text: 'BASE_MEMORY' }], todos: [] };
  await writeJson(file, memory);
  const handlers = {}, sections = [];
  const ctx = { on: (event, fn) => { handlers[event] = fn; }, effect: fn => fn(), permissionPresets: { set() {} },
    systemPrompt: { section: value => sections.push(value), getSectionOrder: () => 0, suppressRuntimeContext() {} } };
  apply(ctx, { owner: true, personaFile });
  const first = new AbortController().signal;
  const initial = sections[0].text({ signal: first });
  memory.facts.push({ id: 'new', text: 'NEW_MEMORY' }); await writeJson(file, memory);
  const second = new AbortController().signal;
  assert.equal(sections[0].text({ signal: second }), initial);
  const prompt = buildPrompt('', { kind: 'private', text: 'hello' }, { scope: 'owner-private', history: [], memory }, 'OWNER', [], 'dsh');
  const message = { role: 'user', source: { kind: 'user-rpc' }, content: [{ type: 'text', text: prompt }, { type: 'text', text: '当前北京时间' }] };
  const result = await handlers['agent/pre-step']({ agent: { session: { surface: { nodes: [] } } }, step: 1, signal: second }, async () => ({ kind: 'enter', messages: [message] }));
  const content = result.messages.at(-1).content;
  assert.match(content.at(-2).text, /NEW_MEMORY/); assert.equal(content.at(-1).text, '当前北京时间');
  assert.equal((JSON.stringify(result.messages).match(/NEW_MEMORY/g) || []).length, 1);
  memory.facts[0].text = 'CORRECTED_MEMORY'; await writeJson(file, memory);
  const next = sections[0].text({ signal: new AbortController().signal });
  assert.match(next, /CORRECTED_MEMORY/); assert.doesNotMatch(next, /BASE_MEMORY/);
});

test('Harmonia restricts only its own agent and injects delegation rules outside the persona', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'preset-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config')); const personaFile = path.join(root, 'config/PERSONA.md');
  await writeFile(personaFile, 'PERSONA_UNIT');
  for (const owner of [true, false]) {
    const handlers = {}, restrictions = [], sections = [], permissions = [];
    const ctx = {
      on: (event, fn) => { handlers[event] = fn; },
      effect: fn => fn(),
      permissionPresets: { set: (...args) => permissions.push(args) },
      systemPrompt: { section: value => sections.push(value), getSectionOrder: () => 0, suppressRuntimeContext() {} },
    };
    apply(ctx, { owner, personaFile });
    assert.equal(restrictions.length, 0);
    handlers['agent/created']({ agent: { session: 'only-this-session', ctx: {
      get: name => { assert.equal(name, 'tools'); return { restrict: value => restrictions.push(value) }; },
    } } });
    assert.deepEqual(restrictions, [{ allow: owner ? OWNER_TOOLS : PUBLIC_TOOLS }]);
    assert.deepEqual(permissions, [['only-this-session', owner ? 'danger-full-access' : 'read-only']]);
    const text = sections[0].text();
    assert.match(text, /聊天正文直接输出普通文字/);
    assert.doesNotMatch(text, /输出严格 JSON|每轮JSON都必须/);
    assert.doesNotMatch(text, /当前北京时间/);
    assert.match(text, /长期记忆由你自由维护/);
    if (owner) {
      assert.ok(text.includes(ASSESSMENT_INSTRUCTION));
      assert.ok(text.indexOf(ASSESSMENT_INSTRUCTION) < text.indexOf('长期记忆参考资料：'));
      assert.match(text, /复杂排障/);
      assert.match(text, /Codex派活\.md/);
      assert.match(text, /启动成功不等于完成/);
    } else {
      assert.doesNotMatch(text, /Codex CLI/);
      assert.ok(!text.includes(ASSESSMENT_INSTRUCTION));
    }
  }
});
