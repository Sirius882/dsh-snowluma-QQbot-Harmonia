import { checkGate } from '../vendor/dsh-alive/lib/policy.mjs';

export const CONVERSATION_MS = 30 * 60000;
export const URGENCY_MS = 3 * 60000;
export const URGENCY_THRESHOLD = 24;
const clamp = value => Math.max(0, Math.min(100, value));

export function conversationState(state) {
  // Exclude this transient state from ordinary JSON saves and object spreads.
  if (!state.tsundere) Object.defineProperty(state, 'tsundere', { configurable: true, writable: true, enumerable: false,
    value: { active: false, value: 25, k: null, at: null, expiresAt: null,
      inputVersion: 0, urged: false, urgencyAt: null, urgencyId: null, pendingReceived: [] } });
  return state.tsundere;
}

// Exact integral of dx/dt=k*(x+20)/3, with t in minutes; positive drift never lowers a value above 60.
export function driftTsundere(value, k, minutes) {
  if (!Number.isFinite(k) || k === 0 || minutes <= 0) return value;
  const next = clamp((value + 20) * Math.exp(Math.max(-1, Math.min(1, k)) * minutes / 3) - 20);
  return k > 0 ? Math.max(value, Math.min(60, next)) : next;
}

export function advanceConversation(state, now) {
  const c = conversationState(state);
  if (!c.active) return c;
  if (now >= c.expiresAt) {
    Object.assign(c, { active: false, value: 25, k: null, at: now, expiresAt: null, urgencyAt: null, urgencyId: null, pendingReceived: [], pendingSent: null });
    return c;
  }
  c.value = driftTsundere(c.value, c.k, Math.max(0, now - c.at) / 60000);
  c.at = now;
  return c;
}

export function activateConversation(state, now) {
  const c = advanceConversation(state, now);
  if (!c.active) Object.assign(c, { active: true, value: 25, k: null, at: now, expiresAt: now + CONVERSATION_MS });
  return c;
}

export function tsundereChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const changes = { received: [], sent: [] };
  if (Number.isFinite(value.k) && value.k !== 0) changes.k = Math.max(-1, Math.min(1, value.k));
  if (Number.isFinite(value.delta)) changes.delta = value.delta;
  if (Array.isArray(value.received) && value.received.length <= 50 && value.received.every(row =>
    row && typeof row.id === 'string' && row.id.length <= 180 && Number.isFinite(row.delta))
    && new Set(value.received.map(row => row.id)).size === value.received.length) changes.received = value.received;
  if (Array.isArray(value.sent) && value.sent.length <= 30 && value.sent.every(Number.isFinite)) changes.sent = value.sent;
  return changes.k !== undefined || changes.delta !== undefined || changes.received.length || changes.sent.length ? changes : null;
}

export function applyTsundere(state, changes, now, { outputs = false } = {}) {
  const c = advanceConversation(state, now);
  if (!c.active) return false;
  const received = changes.received.every(row => c.pendingReceived.includes(row.id)) ? changes.received : [];
  if (changes.k === undefined && changes.delta === undefined && !received.length && !(outputs && changes.sent.length)) return false;
  c.value = clamp(c.value + (changes.delta ?? 0) + received.reduce((sum, row) => sum + row.delta, 0));
  c.pendingReceived = c.pendingReceived.filter(id => !received.some(row => row.id === id));
  if (changes.k !== undefined) c.k = changes.k;
  if (outputs) c.pendingSent = { inputVersion: c.inputVersion, deltas: [...changes.sent] };
  return true;
}

export function recordConversation(state, event, now) {
  const c = activateConversation(state, now);
  c.expiresAt = now + CONVERSATION_MS;
  c.urgencyAt = null;
  if (event.type === 'received') {
    c.inputVersion++; c.urged = false; c.urgencyId = null; c.pendingSent = null;
    c.pendingReceived = [...c.pendingReceived, event.id].slice(-50);
  } else if (!event.failure) {
    if (c.pendingSent?.inputVersion === c.inputVersion && c.pendingSent.deltas.length) c.value = clamp(c.value + c.pendingSent.deltas.shift());
    c.lastSentAt = now; c.lastSentValue = c.value;
    if (!c.urged && c.value < URGENCY_THRESHOLD) c.urgencyAt = now + URGENCY_MS;
  }
  return c;
}

export function continuationGate(state, config, now, { agentExists = true, agentRunning = false } = {}) {
  const gate = checkGate(state, { ...config, minSilenceMin: 0, cooldownMin: 0 }, { kind: 'interrupted', attempts: 0 },
    { now, agentExists, agentRunning, exempt: { quota: true } });
  // This continues an ongoing conversation; annoyance must not suppress the requested repair attempt.
  const failed = gate.failed.filter(reason => reason !== 'G9:debt' && reason !== 'G10:attempts');
  return { pass: !failed.length, failed };
}

export const TSUNDERE_INSTRUCTION = `主人私聊启用本轮傲娇状态时，另输出tsundereUpdate:{k,delta,received:[{id,delta}],sent:[delta,...]}。它独立于每6条的aliveUpdate，每轮都评估；字段不会发送给用户。每次傲娇评估必须同时返回两个有限数值k和delta，不能省略；k决定随后随时间的变化，顶层delta是立即加到当前傲娇值的修正量，无即时修正也必须写delta:0。received逐一列出事实中pendingReceived的消息ID及它对倾向的增减，sent按计划的每条正文（默认一条，显式bubbles按数组）、sticker、images、files顺序给出发出后的增减，不按标点拆句；已列入received或sent的消息增减不要再计入顶层delta，不改未确认发送的状态。
傲娇值0到100表示同一段连续对话中“傲”到“娇”的程度，不是爱意强弱、不是新情绪，也不是开关。结合当前PERSONA.md：低值偏调皮、装矜持、好面子、有一点犟；高值偏粘人、温存、体贴，二者可以混合，不能演成冷漠拒绝或机械台词。先根据收到的话预估received变化，再据此自然回复。真心想陪伴仍会先嘴犟，话题打开、被哄或解释误会后能慢慢软下来；严肃倾诉按人设体贴回应。不要公开数值、系数、倒计时或内部机制。
k由本次聊天模型依据消息、语境和其他情绪判断，必须为[-1,0)或(0,1]的非零有限数，超界会截到-1或1；正数随等待更娇，负数更傲。思念较高通常正向变化更快、较难回落；吃醋或恼火时较慢增长、较易回落，仍按具体语境判断，不另加固定关键词或情绪公式。以分钟计dx/dt=k*(x+20)/3，积分x(t)=(x0+20)*exp(k*t/3)-20，每秒推进一次；从25、k=0.5开始，3分钟后约54.19。自然增长封顶60，不会把已因消息达到60以上的值压低。30分钟无确认收发后重置25并冻结，下一段对话重启25。沉默评估只需tsundereUpdate:{k,delta}，不虚构收发。`;
