export const MOOD_KEYS = ['missing', 'jealousy', 'warmth', 'worry', 'boredom', 'annoyanceDebt', 'lust'];

export function moodPercentages(mood, { lustEnabled = false } = {}) {
  return Object.fromEntries(MOOD_KEYS.filter(key => key !== 'lust' || lustEnabled).map(key => [key,
    Math.round(Math.max(0, Math.min(1, (Number(mood?.[key]) || 0) / (key === 'annoyanceDebt' ? 60 : 1))) * 10000) / 100]));
}

export function setMoodPercentages(mood, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new Error('No emotion values supplied');
  for (const [key, value] of Object.entries(changes)) {
    if (!MOOD_KEYS.includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('Emotion values must be percentages from 0 to 100');
  }
  for (const [key, value] of Object.entries(changes)) mood[key] = value / 100 * (key === 'annoyanceDebt' ? 60 : 1);
}

export function renderEmotion(mood, { lustEnabled = false } = {}) {
  const labels = { missing: '想念', jealousy: '吃醋', warmth: '暖意', worry: '担心', boredom: '无聊', annoyanceDebt: '恼火' };
  if (lustEnabled) labels.lust = '亲密欲望';
  const values = moodPercentages(mood, { lustEnabled });
  const state = Object.fromEntries(Object.entries(labels).map(([key, label]) => [label, Math.round(values[key])]));
  return `情绪状态（百分比）：\n${JSON.stringify(state)}`;
}
