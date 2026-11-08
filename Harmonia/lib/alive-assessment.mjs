import { randomUUID } from 'node:crypto';
import { setMoodPercentages } from './alive-emotion.mjs';

export const LOOP_KINDS = ['food', 'sleep', 'departure', 'promise', 'task_handoff', 'interrupted'];
const HINTS = ['light', 'warm', 'worried', 'sulky', 'clingy', 'pouty', 'flirty', 'flat'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, lo, hi) => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;

// Accept a fenced or prose-wrapped JSON object, without evaluating model output.
export function assessmentObject(text) {
  if (object(text)) return text;
  if (typeof text !== 'string' || text.length > 64000) return null;
  try { const value = JSON.parse(text); if (object(value)) return value; } catch {}
  for (let start = text.indexOf('{'), attempt = 0; start >= 0 && attempt < 8; start = text.indexOf('{', start + 1), attempt++) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}

export function assessmentChanges(value, rejected = []) {
  const raw = assessmentObject(value);
  if (!raw) { rejected.push('invalid-object'); return {}; }
  const input = object(raw.aliveUpdate) ? raw.aliveUpdate : raw, result = {};
  if (object(input.mood) && Object.keys(input.mood).length && input.moodUnit !== 'percent') rejected.push('mood:missing-or-invalid-unit');
  if (object(input.mood) && input.moodUnit === 'percent') {
    for (const key of Object.keys(input.mood)) {
      if (!['missing', 'jealousy', 'warmth', 'worry', 'boredom', 'annoyanceDebt', 'lust', 'lustPhase'].includes(key)) rejected.push('mood:unknown-field');
      else if (key !== 'lustPhase' && !number(input.mood[key], 0, 100)) rejected.push(`mood:${key}:invalid-value`);
    }
    const mood = Object.fromEntries(['missing', 'jealousy', 'warmth', 'worry', 'boredom', 'annoyanceDebt', 'lust']
      .filter(key => number(input.mood[key], 0, 100)).map(key => [key, input.mood[key]]));
    if (Object.keys(mood).length) result.mood = mood;
    if (['grow', 'decay'].includes(input.mood.lustPhase)) result.lustPhase = input.mood.lustPhase;
  }
  const ctl = input.control;
  if (object(ctl)) {
    if (ctl.action === 'unmute') result.control = { action: 'unmute' };
    else if (ctl.action === 'mute' && number(ctl.minutes, 1, 1440) && typeof ctl.hard === 'boolean'
      && ['user-said-stop', 'user-busy', 'people-around'].includes(ctl.reason)) {
      result.control = { action: 'mute', minutes: ctl.minutes, hard: ctl.hard, reason: ctl.reason };
    }
    if (Object.keys(ctl).length && !result.control) rejected.push('control:invalid-value');
  }
  if (Array.isArray(input.loops) && input.loops.length <= 40) result.loops = input.loops
    .filter(row => object(row) && typeof row.id === 'string' && row.id.length <= 100 && ['answered', 'abandoned', 'stale'].includes(row.status))
    .map(({ id, status }) => ({ id, status }));
  const intent = input.intent;
  if (object(intent) && LOOP_KINDS.includes(intent.kind) && typeof intent.what === 'string' && intent.what.trim() && intent.what.length <= 120
    && typeof intent.quote === 'string' && intent.quote.length <= 400 && number(intent.backInMin, 1, 10080)
    && number(intent.confidence, 0, 1) && HINTS.includes(intent.moodHint)) {
    result.intent = Object.fromEntries(['kind', 'what', 'quote', 'backInMin', 'confidence', 'moodHint'].map(key => [key, intent[key]]));
  }
  if (object(input.episode) && typeof input.episode.id === 'string' && input.episode.id.length <= 100
    && ['replied', 'ignored'].includes(input.episode.outcome)) result.episode = { id: input.episode.id, outcome: input.episode.outcome };
  if (input.goodbyeUntil === null || typeof input.goodbyeUntil === 'string' && Number.isFinite(Date.parse(input.goodbyeUntil))) result.goodbyeUntil = input.goodbyeUntil;
  for (const key of Object.keys(input)) if (!['mood', 'moodUnit', 'control', 'loops', 'intent', 'episode', 'goodbyeUntil'].includes(key)) rejected.push('unknown-field');
  if ('mood' in input && !object(input.mood)) rejected.push('mood:invalid-object');
  if ('control' in input && !object(input.control)) rejected.push('control:invalid-object');
  if ('loops' in input && (!Array.isArray(input.loops) || input.loops.length !== result.loops?.length)) rejected.push('loops:invalid-value');
  if ('intent' in input && !result.intent) rejected.push('intent:invalid-value');
  if ('episode' in input && !result.episode) rejected.push('episode:invalid-value');
  if ('goodbyeUntil' in input && !('goodbyeUntil' in result)) rejected.push('goodbyeUntil:invalid-value');
  return result;
}

export function applyAssessment(state, changes, config, now = Date.now(), rejected = []) {
  const stamp = new Date(now).toISOString();
  const mood = { ...changes.mood };
  if (!config.lustModeEnabled && 'lust' in mood) { delete mood.lust; rejected.push('mood:lust:disabled'); }
  if (Object.keys(mood).length) {
    if (mood.warmth > (state.mood.warmth || 0) * 100) state.mood.lastWarmthAt = stamp;
    if (mood.lust > (state.mood.lust || 0) * 100) state.mood.lastTeasedAt = stamp;
    setMoodPercentages(state.mood, mood);
  }
  if (config.lustModeEnabled && changes.lustPhase) state.mood.lustPhase = changes.lustPhase;
  const ctl = changes.control;
  if (ctl?.action === 'unmute') Object.assign(state.control, { mutedUntil: null, muteReason: null, lastWasStop: false, dayQuotaSuspendedUntil: null, goodbyeUntil: null });
  else if (ctl?.action === 'mute' && (ctl.hard ? config.muteEnabled !== false : config.softMuteEnabled !== false)) {
    Object.assign(state.control, { mutedUntil: new Date(now + ctl.minutes * 60000).toISOString(), muteReason: ctl.reason, lastWasStop: ctl.hard });
    if (ctl.hard) state.control.dayQuotaSuspendedUntil = new Date((Math.floor((now + 28800000) / 86400000) + 1) * 86400000 - 28800000).toISOString();
  }
  for (const edit of changes.loops || []) {
    const loop = state.loops.find(row => row.id === edit.id && ['open', 'due', 'delivered'].includes(row.status));
    if (loop && edit.status === 'answered' && (loop.source === 'free' || loop.source === 'greeting') && !loop.sentAt) {
      rejected.push('loops:unconfirmed-delivery'); continue;
    }
    if (loop) Object.assign(loop, { status: edit.status, closedAt: stamp });
    else rejected.push('loops:unknown-or-closed');
  }
  if (changes.intent?.confidence >= .55 && !state.loops.some(row => row.status === 'open' && row.what === changes.intent.what)) {
    const intent = changes.intent, soft = now + intent.backInMin * 60000;
    state.loops.push({ ...intent, id: `lp_ai_${randomUUID()}`, createdAt: stamp, expectedBackAt: new Date(soft).toISOString(),
      hardDeadlineAt: new Date(soft + intent.backInMin * 60000).toISOString(), source: 'ai', status: 'open', attempts: 0,
      lastAttemptAt: null, sessionId: config.targetSession });
    state.loops = state.loops.slice(-40);
  }
  if (changes.episode) {
    const episode = state.episodes.find(row => row.id === changes.episode.id && row.outcome === 'pending' && row.sentAt);
    if (episode) {
      episode.outcome = changes.episode.outcome;
      if (episode.outcome === 'replied') {
        episode.repliedAfterSec = Math.max(0, Math.round((now - Date.parse(episode.sentAt)) / 1000));
        state.quota.consecutiveReplied = (state.quota.consecutiveReplied || 0) + 1;
        state.quota.consecutiveIgnored = 0;
        const bucket = state.stats.byKind[episode.loopKind] ?? { sent: 0, hit: 0 };
        bucket.hit++; state.stats.byKind[episode.loopKind] = bucket;
        state.stats.totalReplied = (state.stats.totalReplied || 0) + 1;
      } else { state.quota.consecutiveIgnored = (state.quota.consecutiveIgnored || 0) + 1; state.quota.consecutiveReplied = 0; }
    } else rejected.push('episode:unconfirmed-or-closed');
  }
  if ('goodbyeUntil' in changes && (changes.goodbyeUntil === null || Date.parse(changes.goodbyeUntil) > now && Date.parse(changes.goodbyeUntil) <= now + 86400000)) state.control.goodbyeUntil = changes.goodbyeUntil;
}

export const ASSESSMENT_INSTRUCTION = `按本次请求中达妮娅的PERSONA.md人设和上下文评估聊天带来的情绪及状态变化。只报告需要改变的状态，不变的省略；没有变化用{}。
可用判断种类与原dsh-alive兼容，不能发明新的情绪、事件类别或权限：
moodUnit:"percent"，修改mood时必须带此单位标记；输入mood和输出mood都为0到100百分比，不是0到1小数。示例：57%写57，0.57%才写0.57；禁止根据旧历史里的内部小数单位照抄。
mood:{missing,jealousy,warmth,worry,boredom,annoyanceDebt,lust}，七项均为0到100百分比的新值，包括恼火；可选lustPhase:"grow"或"decay"，亲密模式关闭时不改变lust。例：{"moodUnit":"percent","mood":{"warmth":62}}。
control:{action:"mute",minutes:1到1440,hard:boolean,reason:"user-said-stop"|"user-busy"|"people-around"}或{action:"unmute"}。理解主人直接原话的真正控制意图，区分引用、玩笑和工作限制；不要把换话题当成永久停止主动。静音与关系拒绝不是同一件事，情绪变化另外判断。
loops:[{id,status:"answered"|"abandoned"|"stale"}]逐事件判断，不因主人说了任意一句就关闭所有事件。主动free／greeting事项没有sentAt送达证据时不能标answered；提交给DSH或生成回复不等于发送成功。
intent:{kind:"food"|"sleep"|"departure"|"promise"|"task_handoff"|"interrupted",what:string,quote:string,backInMin:number,confidence:0到1,moodHint:"light"|"warm"|"worried"|"sulky"|"clingy"|"pouty"|"flirty"|"flat"}，最多一个新的真实待回访事项；根据明确时间和场景估计，不要把提问或转述当离开。
episode:{id,outcome:"replied"|"ignored"}，只对已确认发送的主动轮次关联回应，不能凭空断言已读。
goodbyeUntil:ISO时间或null，表示双方道别后暂不主动的截止时间；自然结束无需假设拒绝，恢复聊天可解除。
计时、增长曲线、配置开关、真实配额、发送回执、权限和去重由程序负责，不可修改。
注意区分：收到需回复的输入后4分钟仍没成功回复，是对方在等达妮娅，不能反过来怪对方冷落；最后一句由达妮娅发出通常是话题自然结束，不等于已读不回。主动找主人且确认发送后未获回复，可能是未读、忙碌或未回应；没有已读证据，不得当成已读事实。失败通知不等于已经答复。`;
