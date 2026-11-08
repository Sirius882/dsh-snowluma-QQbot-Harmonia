export const HISTORY_DAYS = 4;
export const HISTORY_MAX_MESSAGES = 50;
export const HISTORY_DROP_MESSAGES = 30;
export const HISTORY_DROP_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_AGE_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;

export function messageTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
export function recentHistory(records, now = Date.now(), incoming = 1) {
  if (!Array.isArray(records)) throw new Error('Invalid chat history');
  if (incoming !== 0 && incoming !== 1) throw new Error('Invalid incoming history count');
  let rows = records.map((record, index) => ({ record, index, at: messageTime(record.at) }))
    .filter(({ at }) => Number.isFinite(at) && at <= now)
    .sort((a, b) => a.at - b.at || a.index - b.index);
  while (rows.length && now - rows[0].at >= HISTORY_MAX_AGE_MS) {
    const cutoff = rows[0].at + HISTORY_DROP_AGE_MS;
    rows = rows.filter(row => row.at >= cutoff);
  }
  while (rows.length + incoming >= HISTORY_MAX_MESSAGES) rows = rows.slice(HISTORY_DROP_MESSAGES);
  return rows.map(({ record }) => record);
}
export function recentMessage(message, now = Date.now()) {
  if (message.at === undefined) return true; // Live adapters stamp receipt time when the transport provides none.
  const at = messageTime(message.at);
  return at > now - HISTORY_MAX_AGE_MS && at <= now + 60000;
}
