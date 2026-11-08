import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { moodPercentages } from './alive-emotion.mjs';

export function assessmentSnapshot(state, config) {
  return { mood: moodPercentages(state.mood, { lustEnabled: config.lustModeEnabled }),
    control: Object.fromEntries(['mutedUntil', 'lastWasStop', 'dayQuotaSuspendedUntil', 'goodbyeUntil'].map(key => [key, state.control[key] ?? null])),
    loops: Object.fromEntries(state.loops.map(row => [row.id, row.status])),
    episodes: Object.fromEntries(state.episodes.map(row => [row.id, row.outcome])) };
}

// Callers pass only application-owned metadata and validated numeric/status diffs, never model text.
export function auditAlive(root, record) {
  const dir = path.resolve(root, '../.cache/harmonia/alive-logs'), file = path.join(dir, 'assessment.jsonl');
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(file) && statSync(file).size >= 2 * 1024 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}
