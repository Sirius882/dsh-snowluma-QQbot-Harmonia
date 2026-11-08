import { readFile, writeFile } from 'node:fs/promises';
import { ROOT } from '../lib/config.mjs';
import path from 'node:path';

const file = path.join(ROOT, 'vendor/dsh-alive/lib/index.js');
let source = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
const emotionImport = "import { renderEmotion } from '../../../lib/alive-emotion.mjs'";
if (!source.includes(emotionImport)) source = `${emotionImport}\n${source}`;
const moodControlImport = "import { setMoodPercentages } from '../../../lib/alive-emotion.mjs'";
if (!source.includes(moodControlImport)) source = `${moodControlImport}\n${source}`;
const intelligenceImport = "import { createAliveIntelligence } from '../../../plugins/dsh-agent/alive-intelligence.mjs'";
if (!source.includes(intelligenceImport)) source = `${intelligenceImport}\n${source}`;
source = source.replace("LOG_DIR = join(config.dataDir, 'logs')", "LOG_DIR = rawConfig.harmoniaLogDir || join(config.dataDir, 'logs')");
source = source.replace('const line = `${new Date().toISOString()} [${level}] ${message}`', 'const line = `${new Date().toISOString()} [${level}] alive event (private details omitted)`');
source = source.replaceAll('[dsh-alive] ${message}', '[dsh-alive] event (private details omitted)');
if (!source.includes('mood: state.mood, lustEnabled: config.lustModeEnabled === true,')) {
  source = source.replace('const text = renderImpulse(loop, {', 'const text = renderImpulse(loop, {\n      mood: state.mood, lustEnabled: config.lustModeEnabled === true,');
}
source = source.replace("text: lines.join('\\n'),", 'text: renderEmotion(state.mood, { lustEnabled: config.lustModeEnabled === true }),');
source = source.replace('text: renderEmotion(state.mood, { lustEnabled: config.lustModeEnabled === true }),', `text: [renderEmotion(state.mood, { lustEnabled: config.lustModeEnabled === true }),
          '情绪方向参考（以 PERSONA.md 和当前语境为准）：', MOOD_TONE_LINE[tone] ?? MOOD_TONE_LINE.flat,
          ...(top.key === 'lust' ? [LUST_EXTRA] : [])].join('\\n'),`);
if (!source.includes("cmd === 'set-mood'")) {
  const controlAnchor = "if (cmd === 'unmute') {";
  if (!source.includes(controlAnchor)) throw new Error('Alive control handler changed; review mood control adaptation');
  source = source.replace(controlAnchor, `if (cmd === 'set-mood') {
        try {
          setMoodPercentages(state.mood, raw.values)
          save(true)
          saveMoodSnapshot(true)
        } catch (error) {
          writeFileSync(controlPath, JSON.stringify({ cmd: '', id, doneAt: new Date().toISOString(), ok: false, error: error.message }), 'utf8')
          return
        }
      } else ${controlAnchor}`);
}
source = source.replace(/(?:intelligence\.invalidate\(\)\n\s*)?setMoodPercentages\(state\.mood, raw\.values\)(?:\n\s*intelligence\.invalidate\(\))?/, 'setMoodPercentages(state.mood, raw.values)\n          intelligence.invalidate()');
// Replace semantic recognizers, rather than keeping a parallel regex fallback.
if (!source.includes('const intelligence = createAliveIntelligence(')) {
  const semanticStart = source.indexOf('  /**\n   * 挑逗识别');
  const semanticEnd = source.indexOf('  // 情绪走消息（message 模式）', semanticStart);
  if (semanticStart < 0 || semanticEnd < 0) throw new Error('Alive semantic handlers changed');
  source = source.slice(0, semanticStart) + `  const intelligence = createAliveIntelligence(ctx, { state, config, root: rawConfig.harmoniaRoot, save })

  function onHumanSpeech(text, at, sessionId, channel) {
    if (sessionId) state.focus.sessionId = sessionId
    const h = new Date(at).getHours()
    state.rhythm.hourly[h] = (Number(state.rhythm.hourly[h]) || 0) + 1
    state.rhythm.samples = (Number(state.rhythm.samples) || 0) + 1
    save()
  }

` + source.slice(semanticEnd);
  const assistantStart = source.indexOf("      if (event?.type === 'assistant/message') {");
  const assistantEnd = source.indexOf('    } catch (err) {', assistantStart);
  if (assistantStart < 0 || assistantEnd < 0) throw new Error('Alive assistant observation changed');
  source = source.slice(0, assistantStart) + source.slice(assistantEnd);
  source = source.replace(/^.*const SWEET_RE = .*\r?\n/m, '');
  for (const name of ['detectControl', 'extractLoopIntent', 'saidGoodbyeLast', 'scoreImpulse', 'jitterMs']) source = source.replace(`  ${name},\n`, '');
  source = source.replace(/saidGoodbyeLast\(state\.focus\.shortTerm, \{ now, gapMin: config\.goodnightSilenceMin \}\)/g, 'intelligence.goodbye(now)');
  source = source.replace('moodModule.onUnanswered(state.mood)', "await intelligence.judge(loop, now, 'expired')");
  source = source.replace('const { score, parts } = scoreImpulse(state, loop, config, now)', `const judgment = loop.kind === 'greeting' ? { score: 100, parts: { clock: true } } : await intelligence.judge(loop, now)
      if (!judgment || loop.status !== 'open') continue
      const { score, parts } = judgment
      if (!checkGate(state, config, loop, { now: Date.now(), agentRunning: agent.status === 'running', agentExists }).pass || intelligence.goodbye(Date.now())) continue`);
}
if (/detectControl|extractLoopIntent|saidGoodbyeLast|scoreImpulse|TEASE_STRONG_RE|SWEET_RE\.test|moodModule\.on(?:Unanswered|Rejected|HeCameBack)/.test(source)) throw new Error('Old semantic handler remains in alive runtime');
source = source.replace(/\/\* 2026-10-28 第一版修过头了：[\s\S]*?\*\//, '// 期限作废由程序执行，未回应的情绪解释由 Terra 判断。');
source = source.replace('到期没等到回应 —— 这会儿会想他、会担心，但不记作「被无视」', '期限已过；情绪由模型判断');
if (!source.includes('sentAt: loop.sentAt ?? null,')) source = source.replace('loopKind: loop.kind,\n      at:', 'loopKind: loop.kind,\n      sentAt: loop.sentAt ?? null,\n      at:');
const legacyQuotaStart = source.indexOf('  /* 修历史脏数据。');
if (legacyQuotaStart >= 0) {
  const legacyQuotaEnd = source.indexOf('  let saveTimer = null', legacyQuotaStart);
  if (legacyQuotaEnd < 0) throw new Error('Alive legacy quota migration changed');
  source = source.slice(0, legacyQuotaStart) + '  state.control.dayQuotaSuspendedUntil ??= null\n\n' + source.slice(legacyQuotaEnd);
}
source = source.replace(/function doUnmute\(\) \{(?:\n\s*intelligence.invalidate\(\)\n\s*state.control.goodbyeUntil = null)?/, 'function doUnmute() {\n    intelligence.invalidate()\n    state.control.goodbyeUntil = null');
source = source.replace(/Object.assign\(config, parsed.config\)(?:\n\s*intelligence.invalidate\(\))?/g, 'Object.assign(config, parsed.config)\n    intelligence.invalidate()');
source = source.replace('      rollWindows(now)\n      evolveMood(now)', '      rollWindows(now)\n      intelligence.tick()\n      evolveMood(now)');
await writeFile(file, source);
const policyFile = path.join(ROOT, 'vendor/dsh-alive/lib/policy.mjs');
let policy = await readFile(policyFile, 'utf8');
if (!policy.includes(emotionImport)) policy = `${emotionImport}\n${policy}`;
const start = policy.indexOf('export function renderImpulse(loop, ctx) {');
const end = policy.indexOf('/* ──────────────────────── 6.6', start);
if (start < 0 || end < 0) throw new Error('Alive impulse renderer changed; review the adaptation');
policy = policy.slice(0, start) + `export function renderImpulse(loop, ctx) {
  return [renderEmotion(ctx?.mood, { lustEnabled: ctx?.lustEnabled === true }),
    '情绪方向参考（以 PERSONA.md 和当前语境为准）：', MOOD_LINE[ctx?.moodHint] ?? MOOD_LINE.flat].join('\\n')
}

` + policy.slice(end);
function removeSection(text, from, to) {
  const left = text.indexOf(from);
  if (left < 0) return text;
  const right = text.indexOf(to, left + from.length);
  if (right < 0) throw new Error(`Alive section changed: ${from}`);
  return text.slice(0, left) + text.slice(right);
}
policy = removeSection(policy, '/* ────────────────────────────── 1. open loop', '/* ────────────────────────────── 2. 时间抖动');
policy = removeSection(policy, '/* ────────────────────────────── 4. 打分', '/* ──────────────────────── 4.5 自发念头');
policy = removeSection(policy, '/* ──────────────────────── 6.5 道别闭环', '/** 深夜 / 清早 / 饭点');
policy = removeSection(policy, '/* ────────────────────────────── 6. 自然语言控制', '/* ────────────────────────────── 7. 杂项');
await writeFile(policyFile, policy);
const moodFile = path.join(ROOT, 'vendor/dsh-alive/lib/mood.mjs');
let mood = await readFile(moodFile, 'utf8');
mood = removeSection(mood, '/* ────────────────────────────── 事件', '/* ────────────────────────────── 读出来');
await writeFile(moodFile, mood);
console.log('Applied privacy, emotion directions and AI semantic assessment to dsh-alive 1.1.1.');
