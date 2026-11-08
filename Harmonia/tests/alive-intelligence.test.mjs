import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { createAliveIntelligence } from '../plugins/dsh-agent/alive-intelligence.mjs';
import { ASSESSMENT_INSTRUCTION, assessmentObject, assessmentChanges, applyAssessment } from '../lib/alive-assessment.mjs';
import { notifyAliveChat } from '../lib/alive-chat.mjs';
import { validateReply } from '../brain/unified-router.mjs';
import { evolve } from '../vendor/dsh-alive/lib/mood.mjs';
import { moodPercentages } from '../lib/alive-emotion.mjs';
import { driftTsundere, tsundereChanges, advanceConversation, activateConversation, applyTsundere, recordConversation, continuationGate, TSUNDERE_INSTRUCTION } from '../lib/tsundere.mjs';

async function fixture(t, existing, services = {}) {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(path.join(CACHE, 'alive-ai-'));
  await mkdir(path.join(root, 'config')); await mkdir(path.join(root, 'runtime/alive'), { recursive: true });
  await writeFile(path.join(root, 'config/PERSONA.md'), 'PERSONA_CANARY');
  await writeFile(path.join(root, 'config/.env'), 'ONEBOT_ACCESS_TOKEN=fixture-token\n');
  const config = { dataDir: path.join(root, 'runtime/alive'), targetSession: 'owner', lustModeEnabled: true, threshold: 55 };
  const state = existing || { mood: { missing: .8, warmth: .2, annoyanceDebt: 4 }, control: { enabled: true }, quota: { dayCount: 3 },
    loops: [], episodes: [], stats: { byKind: {} }, focus: {} };
  const hooks = {}, cleanups = [], calls = [], timers = new Set(), outputs = [], saves = [];
  let time = Date.parse('2026-11-07T04:00:00Z');
  const ctx = { on(name, fn) { (hooks[name] ||= []).push(fn); }, effect(fn) { const dispose = fn(); if (dispose) cleanups.push(dispose); },
    get: name => ({ ...services, llm: { stream(request) { calls.push(request); return hooks['llm/stream'][0](request, async function* () {
      const output = outputs.shift() ?? '{}';
      if (typeof output === 'function') yield* await output(request);
      else yield { type: 'text-delta', text: output };
    }); } }, agentDefaultModel: { currentSelection: () => ({ provider: 'local-provider', model: 'gpt-6-astra' }) } })[name] };
  const api = createAliveIntelligence(ctx, { state, config, root, save() { saves.push(time); }, now: () => time,
    setTimer(fn, ms) { const task = { fn, at: time + ms }; timers.add(task); return task; }, clearTimer(task) { timers.delete(task); } });
  t.after(async () => { for (const fn of cleanups) fn(); await rm(root, { recursive: true, force: true }); });
  const capture = async request => { for await (const _ of hooks['llm/stream'][0](request, async function* () {})) {} };
  const request = { provider: 'local-provider', model: 'gpt-6-astra', reasoningEffort: 'low', maxTokens: 4000, sessionId: 'owner',
    messages: [{ role: 'system', content: `PERSONA_CANARY\n${ASSESSMENT_INSTRUCTION}\n${TSUNDERE_INSTRUCTION}` }, { role: 'user', content: [{ type: 'text', text: 'OLD_CLOCK_AND_INPUT' }] }],
    tools: [{ name: 'pwsh', description: 'fixture', inputSchema: {} }], toolHistory: [] };
  await capture(request);
  const event = (type, id, extra = {}) => api.receive({ type, id: String(id), text: `message ${id}`, ...extra });
  const end = value => hooks['session/event'][0]({ id: 'owner', snapshotEvents: () => [{ type: 'assistant/message', data: { turn: 1,
    message: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } }] }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  return { api, config, state, calls, outputs, hooks, capture, request, event, end, timers, root, saves,
    advance(ms) { time += ms; }, async fire() { for (const task of [...timers]) if (task.at <= time) { timers.delete(task); task.fn(); } await new Promise(resolve => setImmediate(resolve)); } };
}

test('alive never overrides the chat model even when lust dominates', async t => {
  const f = await fixture(t);
  f.config.moodInjection = true; f.state.mood.lust = 1;
  assert.equal(f.hooks['agent/request'], undefined);
  f.event('received', 'no-routing'); await f.api.assessIdle();
  assert.equal(f.calls.at(-1).model, f.request.model);
  assert.equal(f.calls.at(-1).reasoningEffort, f.request.reasoningEffort);
});

test('assessment parsing tolerates fences/prose and validates only original state categories', () => {
  assert.deepEqual(assessmentObject('answer:\n```json\n{"mood":{"warmth":30}}\n```'), { mood: { warmth: 30 } });
  assert.equal(assessmentObject('broken text'), null);
  const changes = assessmentChanges({ moodUnit: 'percent', mood: { warmth: 77, lust: 101, missing: '99', madeUp: 100 }, quota: { dayCount: 0 },
    control: { action: 'mute', minutes: 99999, hard: true, reason: 'user-said-stop' }, loops: [{ id: 'one', status: 'answered' }, { id: 'two', status: 'delete' }],
    intent: { kind: 'hacked', what: 'bad' }, episode: { id: 'ep', outcome: 'replied' } });
  assert.deepEqual(changes, { mood: { warmth: 77 }, loops: [{ id: 'one', status: 'answered' }], episode: { id: 'ep', outcome: 'replied' } });
});

test('sparse state changes preserve quota, close only named loops, and do not invent delivery', () => {
  const state = { mood: { warmth: .2, lust: .8 }, control: {}, quota: { dayCount: 5 }, loops: [{ id: 'one', status: 'open' }, { id: 'two', status: 'open' }],
    episodes: [{ id: 'ep', outcome: 'pending' }], stats: { byKind: {} } };
  applyAssessment(state, assessmentChanges({ moodUnit: 'percent', mood: { warmth: 55, lust: 0 }, loops: [{ id: 'one', status: 'answered' }], episode: { id: 'ep', outcome: 'ignored' }, quota: { dayCount: 0 } }), { lustModeEnabled: false });
  assert.equal(state.mood.warmth, .55); assert.equal(state.mood.lust, .8); assert.equal(state.quota.dayCount, 5);
  assert.equal(state.loops[0].status, 'answered'); assert.equal(state.loops[1].status, 'open'); assert.equal(state.episodes[0].outcome, 'pending');
});

test('each confirmed send or selected input refreshes four minutes; dedup does not count twice', async t => {
  const f = await fixture(t);
  f.event('received', 1); const first = f.state.chatAI.dueAt;
  f.advance(30000); f.event('sent', 2); assert.equal(f.state.chatAI.dueAt, first + 30000);
  f.event('sent', 2); assert.equal(f.state.chatAI.count, 2);
  f.advance(239999); await f.fire(); assert.equal(f.calls.length, 0);
  f.advance(1); await f.fire(); assert.equal(f.calls.length, 1); assert.equal(f.state.chatAI.count, 0);
});

test('idle assessment reuses the complete last model request prefix and never runs a chat turn', async t => {
  const f = await fixture(t); f.outputs.push('```json\n{"moodUnit":"percent","mood":{"warmth":44}}\n```');
  f.event('received', 1); await f.api.assessIdle();
  const request = f.calls[0], { messages, signal, ...rest } = request;
  const { messages: original, ...before } = f.request;
  assert.deepEqual(rest, before); assert.deepEqual(messages.slice(0, -1), original);
  assert.match(messages.at(-1).content[0].text, /不是聊天|不要执行工具|没有已读证据/);
  assert.equal(JSON.stringify(request).split(ASSESSMENT_INSTRUCTION.split('\n')[0]).length - 1, 1);
  assert.match(messages.at(-1).content[0].text, /waitingForReply":true/);
  assert.equal(f.state.mood.warmth, .44);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.config.dataDir, 'alive-last-request.json'), 'utf8')), f.request);
});

test('six messages piggyback on a normal turn and only confirmed delivery advances output count', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.event(i % 2 ? 'sent' : 'received', i);
  const result = await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  assert.match(result.messages[0].content[0].text, /已连续收发5条/);
  assert.ok(!result.messages[0].content[0].text.includes(ASSESSMENT_INSTRUCTION));
  assert.match(result.messages[0].content[0].text, /按前文的内部状态评估规则/);
  f.end({ aliveUpdate: { moodUnit: 'percent', mood: { warmth: 61 } } });
  assert.equal(f.state.mood.warmth, .2); assert.equal(f.state.chatAI.count, 5);
  f.event('sent', 6); assert.equal(f.state.chatAI.count, 0); assert.equal(f.state.mood.warmth, .61); assert.equal(f.calls.length, 0);
  const normal = validateReply({ reply: true, bubbles: ['hello'], sticker: '', facts: [], todos: [], slang: [], impressions: [], aliveUpdate: { moodUnit: 'percent', mood: { warmth: 61 } } });
  assert.equal(normal.aliveUpdate, undefined); assert.deepEqual(normal.bubbles, ['hello']);
});

test('five messages, idle, five messages, idle makes exactly two assessments and resets the counter', async t => {
  const f = await fixture(t);
  for (let batch = 0; batch < 2; batch++) {
    for (let i = 0; i < 5; i++) f.event(i % 2 ? 'sent' : 'received', `${batch}-${i}`);
    assert.equal(f.state.chatAI.count, 5); f.advance(300000); await f.fire(); assert.equal(f.state.chatAI.count, 0);
  }
  assert.equal(f.calls.length, 2);
});

test('inline state recovery retains a complete update but never applies a truncated update', async t => {
  for (const complete of [false, true]) {
    const f = await fixture(t);
    for (let i = 0; i < 5; i++) f.event(i % 2 ? 'sent' : 'received', i);
    await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    f.end('{"reply":true,"bubbles":["OK"],"aliveUpdate":{"moodUnit":"percent","mood":{"warmth":61}'
      + (complete ? '}' : ',"loops":[{"status":'));
    f.event('sent', 6);
    assert.equal(f.state.mood.warmth, complete ? .61 : .2);
  }
});

test('plain text with separate metadata updates mood and tsundere without exposing internal fields', async t => {
  for (const complete of [false, true]) {
    const f = await fixture(t);
    for (let i = 0; i < 5; i++) f.event(i % 2 ? 'sent' : 'received', i);
    const decision = await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    assert.match(decision.messages.at(-1).content[0].text, /正文无需JSON/);
    const metadata = { aliveUpdate: { moodUnit: 'percent', mood: { warmth: 61 } },
      tsundereUpdate: { k: .4, delta: 5, received: f.state.tsundere.pendingReceived.map(id => ({ id, delta: 0 })), sent: [0] } };
    f.end('完整正文\n```harmonia\n' + JSON.stringify(metadata) + (complete ? '\n```' : ''));
    f.event('sent', 6);
    assert.equal(f.state.mood.warmth, complete ? .61 : .2);
    assert.equal(f.state.tsundere.k, complete ? .4 : null);
  }
});

test('invalid format and failed stream preserve state without fallback rules or repeated idle requests', async t => {
  const f = await fixture(t);
  for (const output of ['not JSON', '{"reply":true,"bubbles":["wrong"]}', async function* () { yield { type: 'text-delta', text: '{"mood":{"warmth":99}}' }; yield { type: 'finish', reason: { kind: 'error' } }; }]) {
    f.outputs.push(output); f.event('received', randomId()); await f.api.assessIdle(); assert.equal(f.state.mood.warmth, .2);
  }
  assert.equal(f.state.chatAI.lastEvaluation.ok, false); assert.equal(f.state.chatAI.dueAt, null);
  function randomId() { return `event-${f.calls.length}`; }
});

test('new input, manual mood changes and reset invalidate an in-flight evaluation', async t => {
  const f = await fixture(t);
  let release;
  f.outputs.push(async function* () { await new Promise(resolve => { release = resolve; }); yield { type: 'text-delta', text: '{"mood":{"warmth":99}}' }; });
  f.event('received', 1); const pending = f.api.assessIdle(); await new Promise(resolve => setImmediate(resolve));
  f.event('received', 2); release(); await pending; assert.equal(f.state.mood.warmth, .2);
  f.api.invalidate(); f.event('reset', 3);
  assert.equal(f.state.chatAI.count, 0); assert.deepEqual(f.state.chatAI.events, []);
  await f.api.assessIdle(); assert.equal(f.calls.length, 1); assert.equal(f.state.chatAI.lastError, 'no-chat-request');
});

test('Terra scores semantic events with no tools, caches its decision, and leaves the global model unchanged', async t => {
  const f = await fixture(t), loop = { id: 'lp', kind: 'free' };
  f.outputs.push('{"score":70,"aliveUpdate":{"moodUnit":"percent","mood":{"warmth":46}}}');
  assert.equal((await f.api.judge(loop, Date.now())).score, 70);
  assert.equal((await f.api.judge(loop, Date.now())).score, 70);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, 'gpt-6.1-terra'); assert.deepEqual(f.calls[0].tools, []);
  assert.equal(f.state.mood.warmth, .46); assert.equal(f.request.model, 'gpt-6-astra');
});

test('failure notices keep the user waiting; proactive reply attribution requires actual sent evidence', async t => {
  const f = await fixture(t); f.state.episodes.push({ id: 'ep', loopId: 'lp', loopKind: 'free', outcome: 'pending' });
  f.event('received', 1); f.event('sent', 2, { failure: true }); assert.equal(f.state.chatAI.waitingForReply, true);
  f.event('sent', 3, { proactive: { loopId: 'lp' } }); assert.ok(f.state.episodes[0].sentAt);
  applyAssessment(f.state, assessmentChanges({ episode: { id: 'ep', outcome: 'replied' } }), f.config);
  assert.equal(f.state.episodes[0].outcome, 'replied'); assert.equal(f.state.quota.dayCount, 3);
});

test('natural time evolution stays local and an event notification failure does not repeat a send', async t => {
  const f = await fixture(t), before = f.state.mood.missing;
  evolve(f.state.mood, .1, { hourOfDay: 12, hoursSinceQq: 1 }); assert.ok(f.state.mood.missing > before); assert.equal(f.calls.length, 0);
  let requests = 0;
  await notifyAliveChat({ brain: 'dsh', dshUrl: 'http://localhost', token: 'fixture' }, { type: 'sent', id: 'one' }, async () => { requests++; throw new Error('offline'); });
  assert.equal(requests, 1);
});

test('replaced keyword and fixed scoring recognizers are removed from the installed runtime', async () => {
  const index = await readFile(new URL('../vendor/dsh-alive/lib/index.js', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../vendor/dsh-alive/lib/policy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /TEASE_STRONG_RE|SWEET_RE\.test|scoreImpulse|detectControl|extractLoopIntent|saidGoodbyeLast/);
  assert.doesNotMatch(policy, /const MUTE_RULES|const PATTERNS|export function scoreImpulse|export function saidGoodbyeLast/);
});

test('manual adjustment while a normal reply is generating prevents stale inline changes', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.event(i % 2 ? 'sent' : 'received', i);
  await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  f.api.invalidate(); f.state.mood.warmth = .4;
  f.end({ aliveUpdate: { moodUnit: 'percent', mood: { warmth: 99 } } }); f.event('sent', 6);
  assert.equal(f.state.mood.warmth, .4); assert.equal(f.state.chatAI.count, 6);
});

test('auxiliary naming requests do not replace the cached chat request', async t => {
  const f = await fixture(t);
  await f.capture({ ...f.request, purpose: 'session-title', messages: [{ role: 'user', content: 'TITLE_ONLY' }], tools: [] });
  f.event('received', 1); await f.api.assessIdle();
  assert.deepEqual(f.calls[0].messages.slice(0, -1), f.request.messages); assert.deepEqual(f.calls[0].tools, f.request.tools);
});

test('a successful tool message refreshes the next model step without creating a separate evaluation', async t => {
  const f = await fixture(t), args = { agent: { session: { id: 'owner' } }, step: 1 };
  f.event('received', 1);
  await f.hooks['agent/pre-step'][0](args, async () => ({ kind: 'enter', messages: [] }));
  f.event('sent', 'share');
  const result = await f.hooks['agent/pre-step'][0]({ ...args, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
  assert.match(result.messages[0].content[0].text, /已连续收发2条/); assert.equal(f.calls.length, 0);
});

test('confirmed history uses the shared batched window and an explicit unmute releases goodbye state', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 49; i++) f.event('sent', i);
  assert.equal(f.state.chatAI.events.length, 49); f.event('sent', 49);
  assert.equal(f.state.chatAI.events.length, 20);
  f.state.control.goodbyeUntil = new Date(Date.now() + 3600000).toISOString();
  applyAssessment(f.state, assessmentChanges({ control: { action: 'unmute' } }), f.config);
  assert.equal(f.state.control.goodbyeUntil, null);
});

test('assessment input uses explicit percent units for every emotion, including debt', async t => {
  const f = await fixture(t); f.state.mood.jealousy = .57; f.state.mood.annoyanceDebt = 30;
  assert.deepEqual(moodPercentages(f.state.mood, { lustEnabled: false }), {
    missing: 80, jealousy: 57, warmth: 20, worry: 0, boredom: 0, annoyanceDebt: 50,
  });
  f.event('received', 1);
  const result = await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  const text = result.messages[0].content[0].text, facts = JSON.parse(text.slice(text.lastIndexOf('\n{"time":') + 1));
  assert.equal(facts.moodUnit, 'percent'); assert.equal(facts.mood.jealousy, 57); assert.equal(facts.mood.annoyanceDebt, 50);
  assert.equal(facts.mood.lastRejectedAt, undefined); assert.match(text, /harmonia内部块包含aliveUpdate/);
});

test('actual fractional output without units is rejected instead of lowering emotions a hundredfold', async t => {
  const f = await fixture(t); f.state.mood.jealousy = .57;
  f.outputs.push('{"mood":{"jealousy":0.57,"warmth":0.28}}');
  f.event('received', 1); await f.api.assessIdle();
  assert.equal(f.state.mood.jealousy, .57); assert.equal(f.state.mood.warmth, .2);
  assert.equal(f.state.chatAI.lastEvaluation.ok, false);
  const rejected = []; assert.deepEqual(assessmentChanges({ moodUnit: 'fraction', mood: { jealousy: .57 } }, rejected), {});
  assert.deepEqual(rejected, ['mood:missing-or-invalid-unit']);
  f.outputs.push('{"moodUnit":"percent","mood":{"jealousy":0.57}}');
  f.event('received', 2); await f.api.assessIdle();
  assert.ok(Math.abs(f.state.mood.jealousy - .0057) < 1e-9, 'Explicit fractional percentages are legitimate; never guess a factor of 100');
});

test('missing or invalid sixth-message updates remain pending, do not run another request, and recover on the next normal turn', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.event(i % 2 ? 'sent' : 'received', i);
  const step = () => f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  await step(); f.end({ reply: true, bubbles: ['normal reply'] }); f.event('sent', 6);
  assert.equal(f.state.chatAI.count, 6); assert.equal(f.state.chatAI.lastEvaluation, undefined);
  f.event('received', 7); const next = await step(); assert.match(next.messages[0].content[0].text, /程序已确认情绪状态评估到期/);
  f.end({ aliveUpdate: { mood: { warmth: .6 } } });
  assert.equal(f.state.chatAI.count, 7); assert.equal(f.state.mood.warmth, .2); assert.equal(f.state.chatAI.lastEvaluation.ok, false);
  f.event('sent', 8); f.event('received', 9); await step(); f.end({ aliveUpdate: {} });
  assert.equal(f.state.chatAI.count, 3); assert.equal(f.state.chatAI.lastEvaluation.ok, true); assert.equal(f.calls.length, 0);
});

test('unconfirmed proactive events cannot be closed as answered', async t => {
  const f = await fixture(t);
  f.state.loops.push({ id: 'free', source: 'free', status: 'delivered' }, { id: 'promise', source: 'ai', status: 'open' });
  const rejected = [];
  applyAssessment(f.state, assessmentChanges({ loops: [{ id: 'free', status: 'answered' }, { id: 'promise', status: 'answered' }] }), f.config, Date.now(), rejected);
  assert.equal(f.state.loops[0].status, 'delivered'); assert.equal(f.state.loops[1].status, 'answered');
  assert.deepEqual(rejected, ['loops:unconfirmed-delivery']);
  f.event('sent', 'proactive', { proactive: { loopId: 'free' } });
  applyAssessment(f.state, assessmentChanges({ loops: [{ id: 'free', status: 'answered' }] }), f.config);
  assert.equal(f.state.loops[0].status, 'answered');
});

test('audit contains actual numeric changes and rejection reasons, without message text or raw model output', async t => {
  const f = await fixture(t), secret = 'PRIVATE_CHAT_AUDIT_CANARY';
  f.event('received', 1, { text: secret });
  f.outputs.push('{"moodUnit":"percent","mood":{"warmth":64}}'); await f.api.assessIdle();
  f.event('received', 2); f.outputs.push(JSON.stringify({ mood: { warmth: .7 }, [secret]: secret })); await f.api.assessIdle();
  const text = await readFile(path.resolve(f.root, '../.cache/harmonia/alive-logs/assessment.jsonl'), 'utf8');
  assert.doesNotMatch(text, new RegExp(secret));
  const rows = text.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.requestId === f.state.chatAI.lastRequestId && row.type === 'assessment');
  assert.ok(rows.some(row => row.outcome === 'applied' && row.changes.some(change => change.field === 'mood.warmth' && change.before === 20 && change.after === 64)));
  assert.ok(rows.some(row => row.outcome === 'rejected' && row.rejected.includes('mood:missing-or-invalid-unit')));
});

test('tsundere drift has an exact nonlinear integral, grows faster at higher values, and only natural growth caps at 60', () => {
  const evolved = driftTsundere(25, .7, .4);
  assert.ok(Math.abs(evolved - (45 * Math.exp(.7 * .4 / 3) - 20)) < 1e-10);
  assert.ok(Math.abs(driftTsundere(25, .5, 3) - ((25 + 20) * Math.exp(.5) - 20)) < 1e-10);
  assert.ok(driftTsundere(25, .5, 3) > 54 && driftTsundere(25, .5, 3) < 55);
  assert.ok(driftTsundere(45, .7, 1) - 45 > driftTsundere(25, .7, 1) - 25);
  assert.ok(Math.abs(driftTsundere(driftTsundere(25, .7, .2), .7, .2) - evolved) < 1e-10);
  assert.equal(driftTsundere(25, 1, 3000), 60); assert.equal(driftTsundere(80, 1, 10), 80);
  assert.ok(driftTsundere(80, -.5, 10) < 80); assert.equal(driftTsundere(25, -1, 3000), 0);
  assert.equal(tsundereChanges({ k: 10, delta: 0 }).k, 1); assert.equal(tsundereChanges({ k: -10, delta: 0 }).k, -1);
  for (const k of [undefined, 0, NaN, Infinity, '0.5', null]) {
    assert.equal(tsundereChanges({ k, delta: 0 }).k, undefined);
    assert.equal(tsundereChanges({ k }), null);
  }
});

test('tsundere k and immediate delta are accepted independently, including explicit zero', () => {
  for (const delta of [undefined, null, '0', NaN, Infinity, -Infinity]) {
    assert.equal(tsundereChanges({ k: .5, delta }).k, .5);
    assert.equal(tsundereChanges({ k: .5, delta }).delta, undefined);
    assert.equal(tsundereChanges({ delta }), null);
  }
  assert.deepEqual(tsundereChanges({ k: .5, delta: 0 }), { k: .5, delta: 0, received: [], sent: [] });
  const state = {}, now = 1000000;
  recordConversation(state, { type: 'received', id: 'first' }, now);
  assert.equal(applyTsundere(state, tsundereChanges({ k: .5, delta: 3, received: [{ id: 'first', delta: 2 }], sent: [4] }), now, { outputs: true }), true);
  assert.equal(state.tsundere.value, 30); assert.equal(state.tsundere.k, .5);
  recordConversation(state, { type: 'sent', id: 'reply' }, now);
  assert.equal(state.tsundere.value, 34);
  assert.equal(applyTsundere(state, tsundereChanges({ k: -.4 }), now), true);
  assert.equal(state.tsundere.value, 34); assert.equal(state.tsundere.k, -.4);
  assert.equal(applyTsundere(state, tsundereChanges({ delta: 3, received: 'bad plan', sent: [null] }), now), true);
  assert.equal(state.tsundere.value, 37); assert.equal(state.tsundere.k, -.4);
  assert.equal(applyTsundere(state, tsundereChanges({ k: 0, delta: -2 }), now), true);
  assert.equal(state.tsundere.value, 35); assert.equal(state.tsundere.k, -.4);
  assert.equal(applyTsundere(state, tsundereChanges({ k: .8, delta: 'bad' }), now), true);
  assert.equal(state.tsundere.value, 35); assert.equal(state.tsundere.k, .8);
  const first = {}; recordConversation(first, { type: 'received', id: 'first' }, now);
  applyTsundere(first, tsundereChanges({ delta: 5 }), now);
  assert.equal(first.tsundere.value, 30); assert.equal(first.tsundere.k, null);
});

test('active conversation advances in memory each second without disk saves or model calls; freezing stops the timer', async t => {
  const f = await fixture(t);
  f.event('received', 'first'); f.state.tsundere.k = .5;
  const start = f.state.tsundere.at;
  const beforeSaves = f.saves.length;
  assert.ok([...f.timers].some(task => task.at === start + 1000));
  f.advance(999); await f.fire(); assert.equal(f.state.tsundere.value, 25);
  f.advance(1); await f.fire();
  const first = f.state.tsundere.value;
  assert.equal(f.saves.length, beforeSaves);
  assert.ok(Math.abs(first - driftTsundere(25, .5, 1 / 60)) < 1e-10);
  assert.ok(first > 25); assert.ok([...f.timers].some(task => task.at === start + 2000));
  f.advance(1000); await f.fire(); assert.ok(f.state.tsundere.value > first); assert.equal(f.calls.length, 0);
  assert.equal(f.saves.length, beforeSaves);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(f.state)), 'tsundere'), false);
  f.advance(30 * 60000); await f.fire();
  assert.equal(f.state.tsundere.active, false); assert.equal(f.state.tsundere.value, 25);
  assert.equal(f.timers.size, 0);
});

test('each message refreshes the 30-minute lifecycle; frozen conversations stay at 25 until new contact', () => {
  const state = {}, start = 1000000;
  assert.equal(advanceConversation(state, start).active, false);
  recordConversation(state, { type: 'received', id: 'first' }, start);
  applyTsundere(state, tsundereChanges({ k: 1, delta: 0, received: [{ id: 'first', delta: 10 }], sent: [5, 8] }), start, { outputs: true });
  recordConversation(state, { type: 'sent', id: 'sent1' }, start);
  assert.equal(state.tsundere.value, 40);
  recordConversation(state, { type: 'sent', id: 'sent2' }, start);
  assert.equal(state.tsundere.value, 48);
  recordConversation(state, { type: 'received', id: 'next' }, start + 29 * 60000);
  assert.equal(advanceConversation(state, start + 31 * 60000).active, true);
  const frozen = advanceConversation(state, start + 59 * 60000);
  assert.equal(frozen.active, false); assert.equal(frozen.value, 25); assert.equal(frozen.k, null);
  assert.equal(advanceConversation(state, start + 100 * 60000).value, 25);
  assert.equal(activateConversation(state, start + 100 * 60000).value, 25);
});

test('urgency threshold is strictly below 24 and the default opening value 25 does not arm it', () => {
  for (const [value, armed] of [[23.999, true], [24, false], [24.001, false], [25, false]]) {
    const state = {};
    recordConversation(state, { type: 'received', id: 'owner' }, 1000);
    state.tsundere.value = value;
    recordConversation(state, { type: 'sent', id: 'reply' }, 1000);
    assert.equal(Boolean(state.tsundere.urgencyAt), armed);
  }
});

test('tsundere changes apply each normal turn before six messages; output deltas wait for real acknowledgements', async t => {
  const f = await fixture(t);
  f.event('received', 'first');
  await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  f.end({ bubbles: ['one', 'two'], aliveUpdate: {}, tsundereUpdate: { k: 2, delta: 0, received: [{ id: 'first', delta: 15 }], sent: [3, 4] } });
  assert.equal(f.state.tsundere.value, 40); assert.equal(f.state.tsundere.k, 1); assert.equal(f.state.chatAI.count, 1);
  f.event('sent', 'one'); assert.equal(f.state.tsundere.value, 43);
  f.event('sent', 'two'); assert.equal(f.state.tsundere.value, 47);
  f.event('sent', 'two'); assert.equal(f.state.tsundere.value, 47);
  assert.equal(f.calls.length, 0); assert.equal(f.state.chatAI.count, 3);
  const output = validateReply({ bubbles: ['normal'], tsundereUpdate: { k: .5 } });
  assert.equal(output.tsundereUpdate, undefined);
  f.event('received', 'new');
  await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  f.end({ bubbles: ['incomplete plan'], aliveUpdate: {}, tsundereUpdate: { k: -1, delta: 0, received: [], sent: [] } });
  assert.equal(f.state.tsundere.k, -1); assert.equal(f.state.tsundere.lastError, undefined);
  assert.deepEqual(f.state.tsundere.pendingReceived, ['new']);
});

test('urgency uses the value at final confirmed send, precedes four-minute evaluation, and stays once until owner input', async t => {
  const followups = [], agent = { status: 'idle', followup: async message => followups.push(message) };
  const f = await fixture(t, undefined, { agents: { get: () => agent } });
  f.config.maxAttempts = 1;
  f.event('received', 'first'); f.state.tsundere.k = 1; f.state.tsundere.value = 23;
  f.event('sent', 'one'); f.advance(179999); await f.fire(); assert.equal(followups.length, 0);
  f.advance(1); await f.fire();
  assert.equal(followups.length, 1); assert.equal(f.state.tsundere.value, 80); assert.equal(f.state.mood.worry, .8);
  assert.equal(f.calls.length, 0); assert.equal(f.state.quota.dayCount, 3);
  assert.equal(followups[0].source.continuation, 'tsundere-urgency');
  assert.match(followups[0].content[0].text, /当前话题续接|无需检索/);
  assert.match(followups[0].content[0].text, /message one/);
  f.state.tsundere.value = 20; f.event('sent', 'followup'); f.advance(180000); await f.fire();
  assert.equal(followups.length, 1);
  f.event('received', 'back'); assert.equal(f.state.tsundere.urged, false);
  f.state.tsundere.value = 20;
  f.event('sent', 'new'); f.advance(180000); await f.fire(); assert.equal(followups.length, 2);
});

test('urgency is re-timed by every final bubble, cancelled by an owner reply, and excludes failures or values at least 24', async t => {
  const followups = [], agent = { status: 'idle', followup: async message => followups.push(message) };
  const f = await fixture(t, undefined, { agents: { get: () => agent } });
  f.event('received', 'one'); f.state.tsundere.value = 20; f.event('sent', 'first'); f.advance(120000); f.event('sent', 'second');
  f.advance(60000); await f.fire(); assert.equal(followups.length, 0);
  f.event('received', 'reply'); f.advance(120000); await f.fire(); assert.equal(followups.length, 0);
  f.state.tsundere.value = 24; f.event('sent', 'high'); f.advance(180000); await f.fire(); assert.equal(followups.length, 0);
  f.state.tsundere.value = 20; f.event('sent', 'failure', { failure: true }); f.advance(180000); await f.fire(); assert.equal(followups.length, 0);
});

test('continuations bypass only conversation cadence and quota, preserve real stops, and never replay after failed submission', async t => {
  const f = await fixture(t, undefined, { agents: { get: () => ({ status: 'idle', followup: async () => { throw new Error('uncertain'); } }) } });
  f.config.maxAttempts = 1;
  Object.assign(f.state.quota, { hourCount: 99, dayCount: 99, lastProactiveAt: new Date('2026-11-07T04:00:00Z').toISOString() });
  f.state.mood.annoyanceDebt = 60;
  assert.equal(continuationGate(f.state, f.config, Date.parse('2026-11-07T04:00:00Z')).pass, true);
  for (const control of [{ enabled: false }, { hardOff: true }, { lastWasStop: true }, { mutedUntil: '2099-01-01T00:00:00Z' }, { dayQuotaSuspendedUntil: '2099-01-01T00:00:00Z' }]) {
    assert.equal(continuationGate({ ...f.state, control: { ...f.state.control, ...control } }, f.config, Date.now()).pass, false);
  }
  assert.equal(continuationGate(f.state, { ...f.config, quietHours: ['00:00-23:59'] }, Date.now()).pass, false);
  assert.equal(continuationGate(f.state, f.config, Date.now(), { agentRunning: true }).pass, false);
  f.event('received', 'owner'); f.state.tsundere.value = 20; f.event('sent', 'low'); f.advance(180000); await f.fire();
  assert.equal(f.state.tsundere.urged, true); assert.ok(f.state.tsundere.urgencyId);
  const restored = await fixture(t, structuredClone(f.state));
  assert.equal(restored.state.tsundere.urged, false); assert.equal(restored.state.tsundere.urgencyAt, null);
  assert.equal(restored.state.tsundere.active, false); assert.equal(restored.state.tsundere.value, 25);
  f.event('reset', 'reset'); assert.equal(f.state.tsundere.active, false); assert.equal(f.state.tsundere.urgencyId, null);
});

test('inline and active idle assessments use available values without requiring the other number or a complete message plan', async t => {
  const f = await fixture(t);
  f.event('received', 'first'); f.state.tsundere.k = .2;
  await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  f.end({ bubbles: ['normal reply'], aliveUpdate: {}, tsundereUpdate: { k: .9, received: [{ id: 'first', delta: 10 }], sent: [5] } });
  assert.equal(f.state.tsundere.value, 35); assert.equal(f.state.tsundere.k, .9);
  assert.deepEqual(f.state.tsundere.pendingReceived, []);
  assert.equal(f.state.tsundere.lastError, undefined);
  f.event('sent', 'reply'); assert.equal(f.state.tsundere.value, 40);
  for (const [id, update, expectedValue, expectedK] of [
    ['k-only', { k: -.4 }, 40, -.4], ['delta-only', { delta: 3 }, 43, -.4],
    ['invalid-k', { k: 0, delta: -2 }, 41, -.4], ['invalid-delta', { k: .8, delta: 'bad' }, 41, .8]]) {
    f.event('received', id);
    await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    f.end({ bubbles: ['normal reply'], aliveUpdate: {}, tsundereUpdate: update });
    assert.equal(f.state.tsundere.value, expectedValue); assert.equal(f.state.tsundere.k, expectedK);
    assert.equal(f.state.tsundere.pendingSent, null); assert.equal(f.state.tsundere.lastError, undefined);
  }
  f.outputs.push('{"aliveUpdate":{},"tsundereUpdate":{"delta":10}}');
  await f.api.assessIdle();
  assert.equal(f.state.tsundere.value, 51); assert.equal(f.state.tsundere.k, .8);
  f.outputs.push('{"aliveUpdate":{},"tsundereUpdate":{"k":-0.6}}');
  await f.api.assessIdle();
  assert.equal(f.state.tsundere.value, 51); assert.equal(f.state.tsundere.k, -.6);
  f.outputs.push('{"aliveUpdate":{}}'); await f.api.assessIdle();
  assert.equal(f.state.tsundere.value, 51); assert.equal(f.state.tsundere.k, -.6);
  assert.equal(f.state.tsundere.lastError, 'update-missing-or-invalid');
  f.outputs.push('{"aliveUpdate":{},"tsundereUpdate":{"k":0.7,"delta":0}}');
  await f.api.assessIdle();
  assert.equal(f.state.tsundere.value, 51); assert.equal(f.state.tsundere.k, .7);
  assert.equal(f.state.tsundere.lastError, undefined);
  assert.match(f.calls.at(-1).messages.at(-1).content[0].text, /必须同时输出tsundereUpdate:\{k,delta\}/);
});

test('idle evaluation adjusts the waiting coefficient without sending a chat, and stale inline results cannot change it', async t => {
  const f = await fixture(t);
  f.event('received', 'first');
  f.outputs.push('{"tsundereUpdate":{"k":-3,"delta":8},"aliveUpdate":{}}');
  await f.api.assessIdle();
  assert.equal(f.state.tsundere.k, -1); assert.equal(f.state.tsundere.value, 33);
  await f.hooks['agent/pre-step'][0]({ agent: { session: { id: 'owner' } }, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  f.event('received', 'new'); f.end({ aliveUpdate: {}, tsundereUpdate: { k: 1, delta: 40 } });
  assert.equal(f.state.tsundere.value, 33); assert.equal(f.state.tsundere.k, -1);
});

test('urgency never lowers values already above 80, and unknown message deltas cannot mutate conversation state', async t => {
  const f = await fixture(t);
  f.event('received', 'owner'); f.state.tsundere.value = 20; f.event('sent', 'low');
  f.state.tsundere.value = 92; f.state.mood.worry = .95;
  const changes = tsundereChanges({ received: [{ id: 'invented-input', delta: -50 }] });
  assert.equal(applyTsundere(f.state, changes, Date.parse('2026-11-07T04:00:00Z')), false);
  assert.equal(f.state.tsundere.value, 92);
  f.advance(180000); await f.fire();
  assert.equal(f.state.tsundere.value, 92); assert.equal(f.state.mood.worry, .95);
  let wake, followups = 0;
  const pending = await fixture(t, undefined, { sessionController: { resolveAgent: () => new Promise(resolve => { wake = resolve; }) } });
  pending.event('received', 'owner'); pending.state.tsundere.value = 20; pending.event('sent', 'low'); pending.advance(180000); await pending.fire();
  pending.event('reset', 'reset'); wake({ agent: { status: 'idle', followup: async () => followups++ } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(followups, 0);
});

test('legacy disk state is ignored and transient state is excluded from subsequent normal saves', async t => {
  const previous = { mood: { worry: .3 }, control: { enabled: true }, quota: { dayCount: 4 },
    loops: [], episodes: [], stats: { byKind: {} }, focus: {},
    tsundere: { active: true, value: 99, k: 1, urgencyId: 'old-disk-id', urgencyAt: 1, expiresAt: Date.now() + 100000 } };
  const f = await fixture(t, previous);
  assert.equal(f.state.tsundere.active, false); assert.equal(f.state.tsundere.value, 25);
  assert.equal(f.state.tsundere.urgencyId, null); assert.equal(f.state.quota.dayCount, 4);
  f.event('received', 'new'); f.state.tsundere.k = .5;
  assert.equal(JSON.parse(JSON.stringify(f.state)).tsundere, undefined);
});

test('authenticated status reads live memory without writing state or refreshing conversation deadlines', async t => {
  let route;
  const f = await fixture(t, undefined, { webServer: { register(value) { route = value; return () => {}; } } });
  f.event('received', 'owner');
  const dueAt = f.state.chatAI.dueAt, expiresAt = f.state.tsundere.expiresAt, saves = f.saves.length;
  const get = async headers => {
    let status, body;
    await route.handler({ method: 'GET', headers }, { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } });
    return { status, body };
  };
  assert.equal((await get({})).status, 403);
  assert.equal((await get({ authorization: 'Bearer fixture-token', origin: 'http://foreign' })).status, 403);
  const result = await get({ authorization: 'Bearer fixture-token' });
  assert.equal(result.status, 200); assert.equal(result.body.tsundere.value, 25);
  assert.equal(result.body.continuationAllowed, true);
  assert.equal(f.saves.length, saves); assert.equal(f.state.chatAI.dueAt, dueAt); assert.equal(f.state.tsundere.expiresAt, expiresAt);
  f.state.control.hardOff = true;
  assert.equal((await get({ authorization: 'Bearer fixture-token' })).body.continuationAllowed, false);
});
