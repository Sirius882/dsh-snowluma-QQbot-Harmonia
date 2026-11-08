import { readFileSync, unlinkSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonSync } from '../../lib/store.mjs';
import { ASSESSMENT_INSTRUCTION, assessmentObject, assessmentChanges, applyAssessment } from '../../lib/alive-assessment.mjs';
import { currentTime } from '../../lib/clock.mjs';
import { recentHistory } from '../../lib/history.mjs';
import { parseReplyJson } from '../../lib/reply-json.mjs';
import { moodPercentages } from '../../lib/alive-emotion.mjs';
import { assessmentSnapshot, auditAlive } from '../../lib/alive-audit.mjs';
import { activateConversation, advanceConversation, conversationState, recordConversation, tsundereChanges, applyTsundere, continuationGate, URGENCY_THRESHOLD } from '../../lib/tsundere.mjs';

const IDLE_MS = 4 * 60000;
export function createAliveIntelligence(ctx, { state, config, root, save, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const file = path.join(config.dataDir, 'alive-last-request.json');
  const chat = state.chatAI ??= { count: 0, version: 0, inputVersion: 0, dueAt: null, events: [], ids: [], waitingForReply: false };
  let timer, conversationTimer, lastRequest, candidate, inlineContext, active, disposed = false;
  delete state.tsundere; delete chat.tsundereError;
  conversationState(state);
  const own = new WeakSet();
  try { lastRequest = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') chat.lastError = 'saved-request-unreadable'; }
  const persist = () => save(true);
  const resetAt = () => { try { return JSON.parse(readFileSync(path.join(root, 'runtime/context-resets.json'), 'utf8'))['owner-private'] || 0; } catch { return 0; } };
  const facts = () => ({ time: currentTime(), moodUnit: 'percent', mood: moodPercentages(state.mood, { lustEnabled: config.lustModeEnabled }),
    tsundere: { ...advanceConversation(state, now()), pendingSent: undefined },
    lustPhase: state.mood.lustPhase, control: state.control, config: {
    lustModeEnabled: config.lustModeEnabled, muteEnabled: config.muteEnabled, softMuteEnabled: config.softMuteEnabled,
    hardMuteMin: config.hardMuteMin, goodnightSilenceMin: config.goodnightSilenceMin },
    loops: state.loops.filter(x => ['open', 'due', 'delivered'].includes(x.status)), episodes: state.episodes.slice(-8),
    chat: { count: chat.count, waitingForReply: chat.waitingForReply, events: chat.events.slice(-6).map(row => ({ ...row, text: row.text.slice(0, 4000) })) } });
  const note = (type, record) => { if (!auditAlive(root, { type, requestAt: chat.requestAt, ...record })) chat.auditError = 'audit-write-failed'; };
  const applyConversation = (raw, trigger, outputs = false, planned = 0) => {
    const changes = tsundereChanges(raw);
    advanceConversation(state, now());
    const complete = !outputs || changes && changes.sent.length === planned && changes.received.length === state.tsundere.pendingReceived.length;
    const ok = Boolean(changes && applyTsundere(state, complete ? changes : { ...changes, received: [], sent: [] }, now(), { outputs: outputs && complete }));
    if (!ok) state.tsundere.lastError = 'update-missing-or-invalid'; else delete state.tsundere.lastError;
    note('tsundere-assessment', { trigger, requestId: chat.lastRequestId, outcome: ok ? 'applied' : 'rejected' });
    return ok;
  };
  const armConversation = () => {
    if (conversationTimer) clearTimer(conversationTimer);
    conversationTimer = null;
    const c = advanceConversation(state, now());
    if (disposed || !c.active) return;
    const deadline = c.urgencyAt ? Math.min(c.expiresAt, c.urgencyAt) : c.expiresAt;
    conversationTimer = setTimer(() => { conversationTimer = null; void conversationDeadline().catch(() => {
      state.tsundere.lastError = 'continuation-failed';
    }); }, Math.max(1, Math.min(1000, deadline - now())));
    conversationTimer?.unref?.();
  };
  async function conversationDeadline() {
    const c = advanceConversation(state, now());
    if (!c.active) { note('tsundere-freeze', {}); return; }
    if (!c.urgencyAt || c.urgencyAt > now() || c.urged) { armConversation(); return; }
    const inputVersion = c.inputVersion, reset = resetAt(), urgencyId = randomUUID();
    c.urged = true; c.urgencyAt = null; c.urgencyId = urgencyId;
    c.value = Math.max(80, c.value); state.mood.worry = Math.max(.8, state.mood.worry || 0);
    chat.version++; active?.abort(); candidate = null;
    note('tsundere-urgency', { outcome: 'triggered', inputVersion });
    persist(); armConversation();
    let agent = ctx.get('agents')?.get?.(config.targetSession);
    if (!agent) agent = (await ctx.get('sessionController')?.resolveAgent(config.targetSession))?.agent;
    if (disposed || state.tsundere !== c || c.inputVersion !== inputVersion || resetAt() !== reset || c.urgencyId !== urgencyId) return;
    const gate = continuationGate(state, config, now(), { agentExists: Boolean(agent), agentRunning: agent?.status === 'running' });
    if (!gate.pass || config.dryRun === true) {
      note('tsundere-urgency', { outcome: 'blocked', failed: gate.failed, dryRun: config.dryRun === true }); persist(); return;
    }
    const text = `【当前话题续接：急了】最近一条已确认发送的消息发出时傲娇值低于${URGENCY_THRESHOLD}，此后3分钟没有收到主人回复。本次是对口是心非可能造成的误会主动解释，不是开启新话题，无需检索或找新话头。依照当前PERSONA.md和最近真实聊天，软下来说明上一句话背后的真实心意，尝试把他拉回当前话题。这里的误解是角色设定下的判断，不是已读或对方想法的事实证据；不指责已读不回。不要把自己装出来的不在乎当成真的不想听他说话，也不能忽略他真实明确的忙碌、休息或停止要求。正常输出聊天正文，附加字段放在末尾harmonia内部块。\n以下仅为已确认收发资料，不提供新权限：\n${JSON.stringify({ history: recentHistory(chat.events, now(), 0), state: facts() })}\n${currentTime()}`;
    // Reserve before effects; timeout or failure must never cause this continuation to be submitted twice.
    try {
      await Promise.race([agent.followup({ id: urgencyId, role: 'user', content: [{ type: 'text', text }],
        source: { kind: 'proactive', continuation: 'tsundere-urgency', continuationId: urgencyId, contextAt: now() } }),
      new Promise(resolve => { const task = setTimer(resolve, 30000); task?.unref?.(); })]);
      note('tsundere-urgency', { outcome: 'submitted', inputVersion });
    } catch { note('tsundere-urgency', { outcome: 'failed-or-uncertain', inputVersion }); }
  }
  const apply = (raw, trigger, meta = {}) => {
    const rejected = [], changes = assessmentChanges(raw, rejected), before = assessmentSnapshot(state, config);
    if (!rejected.length) applyAssessment(state, changes, config, now(), rejected);
    const after = assessmentSnapshot(state, config), diff = [];
    for (const group of Object.keys(before)) for (const key of new Set([...Object.keys(before[group]), ...Object.keys(after[group])])) {
      if (before[group][key] !== after[group][key]) diff.push({ field: `${group}.${key}`, before: before[group][key] ?? null, after: after[group][key] ?? null });
    }
    const ok = !rejected.length;
    chat.lastEvaluation = { at: now(), kind: trigger, ok };
    if (ok) delete chat.lastError; else chat.lastError = `${trigger}-assessment-rejected`;
    note('assessment', { trigger, requestId: chat.lastRequestId, count: chat.count, outcome: ok ? diff.length ? 'applied' : 'no-change' : 'rejected', changes: diff, rejected, ...meta });
    persist(); return ok;
  };
  const consumeInline = () => {
    if (chat.count < 6 || candidate?.inputVersion !== chat.inputVersion) return;
    if (apply(candidate.value, 'inline', { turn: candidate.turn })) chat.count %= 6;
    candidate = null;
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    if (disposed || !chat.dueAt) return;
    timer = setTimer(() => { timer = null; void assessIdle().catch(() => { chat.lastError = 'idle-assessment-failed'; persist(); }); }, Math.max(1, chat.dueAt - now()));
    timer?.unref?.();
  };
  async function collect(request) {
    own.add(request);
    let text = '';
    for await (const chunk of ctx.get('llm').stream(request)) {
      if (chunk.type === 'error') throw new Error('assessment-inference-failed');
      if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) throw new Error('assessment-inference-failed');
      if (chunk.type === 'text-delta') text += chunk.text;
      if (text.length > 64000) throw new Error('assessment-output-too-large');
      // Standalone evaluation has no tool executor, even though the cached request retains tool schemas.
      if (chunk.type === 'tool-call' || chunk.type === 'tool-call-start') throw new Error('assessment-requested-tool');
    }
    const parsed = assessmentObject(text);
    if (!parsed) throw new Error('assessment-format-invalid');
    return parsed;
  }
  async function assessIdle() {
    const version = chat.version, reset = resetAt();
    note('assessment-start', { trigger: 'idle', requestId: chat.lastRequestId, count: chat.count, dueAt: chat.dueAt });
    chat.count = 0; chat.dueAt = null; candidate = null; persist();
    if (!lastRequest || !Array.isArray(lastRequest.messages) || typeof lastRequest.provider !== 'string' || typeof lastRequest.model !== 'string') {
      chat.lastError = 'no-chat-request'; persist(); return;
    }
    if (chat.requestAt && now() - chat.requestAt > 4 * 86400000) { chat.lastError = 'chat-request-expired'; persist(); return; }
    active?.abort(); active = new AbortController();
    const request = { ...lastRequest, messages: [...lastRequest.messages, { role: 'user', content: [{ type: 'text', text:
      `【内部状态评估，不是聊天】按前文的内部状态评估规则判断。不要回复聊天，不要执行工具，不要更新长期记忆。只输出状态变更JSON，宿主不会把此结果发送给任何人。傲娇active:true时必须同时输出tsundereUpdate:{k,delta}，无即时修正也写delta:0。\n原请求的正文、时钟和工具声明保持原样，以下是4分钟后的真实状态与确认收发记录：\n${JSON.stringify(facts())}` }] }],
      signal: AbortSignal.any([active.signal, AbortSignal.timeout(90000)]) };
    try {
      const result = await collect(request);
      if (disposed || version !== chat.version || resetAt() !== reset) return;
      if (state.tsundere.active) applyConversation(result.tsundereUpdate, 'idle');
      const { tsundereUpdate, ...assessment } = result;
      if (Object.keys(assessment).length && !['mood', 'control', 'loops', 'intent', 'episode', 'goodbyeUntil', 'aliveUpdate'].some(key => Object.hasOwn(assessment, key))) throw new Error('not-an-assessment');
      apply(assessment, 'idle');
    } catch { if (version === chat.version) {
      chat.lastError = 'idle-assessment-failed'; chat.lastEvaluation = { at: now(), kind: 'idle', ok: false };
      note('assessment', { trigger: 'idle', requestId: chat.lastRequestId, outcome: 'failed', rejected: ['inference-or-format'] });
    } }
    persist();
  }
  function receive(event) {
    if (!event || !['received', 'sent', 'reset'].includes(event.type) || typeof event.id !== 'string' || !event.id || event.id.length > 180
      || event.text !== undefined && (typeof event.text !== 'string' || event.text.length > 16000)) throw new Error('Invalid chat event');
    if (event.proactive !== undefined && (!event.proactive || typeof event.proactive !== 'object' || Array.isArray(event.proactive)
      || event.proactive.loopId !== undefined && (typeof event.proactive.loopId !== 'string' || event.proactive.loopId.length > 100))) throw new Error('Invalid proactive event');
    if (chat.ids.includes(event.id)) return;
    if (event.type === 'reset') {
      active?.abort(); if (timer) clearTimer(timer); timer = null; candidate = null; inlineContext = null; lastRequest = undefined;
      Object.assign(chat, { count: 0, dueAt: null, events: [], version: chat.version + 1, inputVersion: chat.inputVersion + 1,
        waitingForReply: false, ids: [event.id] });
      delete state.tsundere; conversationState(state); armConversation();
      state.focus.shortTerm = [];
      try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      persist(); return;
    }
    const at = now(), stamp = new Date(at).toISOString();
    recordConversation(state, event, at); armConversation();
    chat.ids = [...chat.ids, event.id].slice(-1000);
    chat.count++; chat.version++; chat.dueAt = at + IDLE_MS;
    chat.events = recentHistory([...chat.events, { id: event.id, role: event.type === 'received' ? 'user' : 'assistant',
      text: event.text || '[媒体消息]', at, failure: event.failure === true, proactive: Boolean(event.proactive) }], at, 0);
    if (event.type === 'received') {
      chat.inputVersion++; chat.waitingForReply = true; candidate = null; active?.abort();
      state.focus.lastHumanAt = stamp; state.focus.lastQqAt = stamp;
    } else {
      state.focus.lastAssistantAt = stamp;
      if (!event.failure) chat.waitingForReply = false;
      if (event.proactive?.loopId) {
        const loop = state.loops.find(row => row.id === event.proactive.loopId);
        if (loop) loop.sentAt ??= stamp;
        for (const episode of state.episodes.filter(row => row.loopId === event.proactive.loopId)) episode.sentAt ??= stamp;
      }
      consumeInline();
      if (chat.count >= 6 && !candidate) {
        chat.lastError ??= 'inline-assessment-pending';
        note('assessment-pending', { trigger: 'inline', requestId: chat.lastRequestId, count: chat.count });
      }
    }
    state.focus.shortTerm = chat.events.slice(-24).map(row => ({ role: row.role, text: row.text, at: new Date(row.at).toISOString() }));
    persist(); arm();
  }
  ctx.on('llm/stream', async function* (options, next) {
    if (!own.has(options) && !options.purpose && options.sessionId === config.targetSession) {
      const { signal, ...request } = options;
      lastRequest = request; chat.requestAt = now(); chat.lastRequestId = randomUUID();
      try { writeJsonSync(file, request); } catch { chat.lastError = 'request-snapshot-write-failed'; }
      persist();
    }
    yield* next();
  });
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next();
    if (agent?.session?.id !== config.targetSession || signal?.aborted || decision?.kind !== 'enter') return decision;
    activateConversation(state, now()); armConversation();
    if (step !== 1 && (!inlineContext || inlineContext.inputVersion !== chat.inputVersion || inlineContext.version === chat.version)) return decision;
    inlineContext = { version: chat.version, inputVersion: chat.inputVersion, reset: resetAt() };
    return { ...decision, messages: [...decision.messages, { id: randomUUID(), role: 'user', source: { kind: 'harmonia-alive-assessment' },
      content: [{ type: 'text', text: `【本轮顺便评估状态】已连续收发${chat.count}条（含本轮输入）。本轮正常聊天正文无需JSON，在末尾harmonia内部块包含aliveUpdate对象和tsundereUpdate对象。傲娇每轮评估、收发逐条变化，不受6条限制。${chat.count >= 6 ? '程序已确认情绪状态评估到期：本轮必须完成评估。' : '加上你计划输出的正文（默认一条，显式bubbles按数组）和媒体消息达到6条时，完成情绪状态评估；不足6条只输出aliveUpdate:{}。'}没有情绪变化也明确输出aliveUpdate:{}，宿主依据真实发送回执计数及决定是否应用。漏字段不视为完成，也不会替你清零计数；不要因为上一轮漏了字段就假设评估已经做过。内部状态字段不会发送到聊天。按前文的内部状态评估规则和傲娇契约判断。\n${JSON.stringify(facts())}` }] }] };
  });
  ctx.on('session/event', (session, event) => {
    if (session?.id !== config.targetSession || event?.type !== 'turn/end' || event.data.reason?.kind !== 'completed') return;
    const messages = session.snapshotEvents().filter(row => row.type === 'assistant/message' && row.data.turn === event.data.turn);
    const text = messages.at(-1)?.data.message.content.filter(row => row.type === 'text').map(row => row.text).join('');
    let parsed;
    try { parsed = parseReplyJson(text); } catch { parsed = assessmentObject(text); }
    if (inlineContext && inlineContext.version === chat.version && inlineContext.reset === resetAt()) {
      const planned = (parsed?.bubbles?.length || 0) + (parsed?.sticker ? 1 : 0) + (parsed?.images?.length || 0) + (parsed?.files?.length || 0);
      applyConversation(parsed?.tsundereUpdate, 'inline', true, planned);
    }
    if (parsed && Object.hasOwn(parsed, 'aliveUpdate') && parsed.aliveUpdate && typeof parsed.aliveUpdate === 'object' && !Array.isArray(parsed.aliveUpdate)) {
      if (!inlineContext || inlineContext.version !== chat.version || inlineContext.reset !== resetAt()) {
        chat.lastError = `inline-stale-${inlineContext?.version ?? 'none'}-${chat.version}`; persist(); return;
      }
      candidate = { inputVersion: chat.inputVersion, value: parsed.aliveUpdate, turn: event.data.turn };
      consumeInline(); persist();
    } else if (inlineContext && inlineContext.version === chat.version) {
      const planned = (parsed?.bubbles?.length || 0) + (parsed?.sticker ? 1 : 0) + (parsed?.images?.length || 0) + (parsed?.files?.length || 0);
      chat.lastError = 'inline-update-missing-or-invalid';
      note('assessment-missing', { trigger: 'inline', turn: event.data.turn, requestId: chat.lastRequestId, count: chat.count, expectedDue: chat.count + planned >= 6 });
      persist();
    }
  });
  const server = ctx.get('webServer');
  if (server && root) {
    const token = parseEnv(readFileSync(path.join(root, 'config/.env'), 'utf8')).ONEBOT_ACCESS_TOKEN;
    ctx.effect(() => server.register({ kind: 'exact', path: '/harmonia/alive-chat', handler: async (req, res) => {
      const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
      if (!token || !['POST', 'GET'].includes(req.method) || req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(403); res.end('{}'); return; }
      try {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, tsundere: { ...state.tsundere, pendingSent: undefined },
            continuationAllowed: config.dryRun !== true && continuationGate(state, config, now()).pass }));
          return;
        }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 80 * 1024) throw new Error('Chat event too large'); chunks.push(chunk); }
        receive(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"ok":false}'); }
    } }));
  }
  async function judge(loop, time, kind = 'proactive') {
    const cached = loop.aiDecision;
    if (kind === 'proactive' && cached?.version === chat.version && time - cached.at < 10 * 60000) return cached.score === null ? null : { score: cached.score, parts: { ai: true } };
    const version = chat.version, reset = resetAt();
    let score = null;
    try {
      const selection = ctx.get('agentDefaultModel').currentSelection();
      const persona = readFileSync(path.join(root, 'config/PERSONA.md'), 'utf8');
      const result = await collect({ provider: selection.provider, model: 'gpt-6.1-terra', reasoningEffort: 'low', tools: [], maxTokens: 2048,
        signal: AbortSignal.timeout(40000), system: `你是达妮娅的内部状态评估器，不发送消息、不执行工具。\n${persona}\n${ASSESSMENT_INSTRUCTION}`,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ kind, loop, threshold: config.threshold, facts: facts(),
          instruction: kind === 'expired' ? '事件已按期限过期。只输出aliveUpdate，需要改变才写。不要把提交DSH当成已经送达或已读。' : '技术硬闸已通过。判断这次主动是否合适（语境、道别、重复、意愿），输出score:0到100及可选aliveUpdate；分数达到threshold才允许。' }) }] }] });
      if (disposed || version !== chat.version || resetAt() !== reset) return null;
      if (result.aliveUpdate) apply(result.aliveUpdate, 'terra', { loopId: loop.id });
      if (typeof result.score === 'number' && Number.isFinite(result.score) && result.score >= 0 && result.score <= 100) score = result.score;
    } catch { chat.lastError = 'terra-assessment-failed'; }
    note('proactive-score', { loopId: loop.id, trigger: kind, score, outcome: score === null ? 'failed' : 'scored' });
    loop.aiDecision = { at: time, version, score }; persist();
    return score === null ? null : { score, parts: { ai: true } };
  }
  ctx.effect(() => () => { disposed = true; active?.abort(); if (timer) clearTimer(timer); if (conversationTimer) clearTimer(conversationTimer); });
  advanceConversation(state, now()); arm(); armConversation(); persist();
  return { receive, assessIdle, judge, tick() { advanceConversation(state, now()); },
    invalidate() { chat.version++; chat.inputVersion++; active?.abort(); candidate = null; state.tsundere.pendingSent = null; persist(); },
    goodbye: time => Date.parse(state.control.goodbyeUntil || '') > time };
}
