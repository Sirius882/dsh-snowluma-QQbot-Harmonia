export function localDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
}
export function awake(now = Date.now()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour >= 7 && hour < 22;
}
export function nextWake(now = Date.now(), random = Math.random) {
  let next = now + (120 + Math.floor(random() * 121)) * 60000;
  while (!awake(next)) next += 15 * 60000;
  return next;
}
export function evidenceUrls(events) {
  const urls = new Set(), calls = new Map(); let searched = false;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    for (const block of event.data.message?.content || []) {
      if (block.type !== 'tool-call') continue;
      let args = {}; try { args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; } catch {}
      if (['web_search', 'bili_watch'].includes(block.name) || (block.name === 'web_call' && args.action === 'search.run')) calls.set(block.id, block.name);
    }
  }
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const data = event.data;
    if (data.error || data.message?.isError || data.outcome?.kind === 'error') continue;
    const text = JSON.stringify(data);
    if (calls.has(data.message?.toolCallId)) {
      for (const url of text.match(/https?:[^\s"<>\\]+/g) || []) urls.add(url.replace(/[),.;]+$/, ''));
      if (urls.size) searched = true;
    }
  }
  return { searched, urls };
}
export function verifiedCandidate(value, evidence, seen = []) {
  if (value?.reply !== true || !Array.isArray(value.bubbles) || !value.bubbles.length || value.bubbles.length > 3
    || value.bubbles.some(x => typeof x !== 'string' || x.length > 1500) || !Array.isArray(value.sources)) return null;
  const sources = value.sources.filter(s => typeof s?.url === 'string' && evidence.urls.has(s.url));
  if (!evidence.searched || !sources.length || sources.every(s => seen.includes(s.url))) return null;
  return { bubbles: value.bubbles, sources: sources.slice(0, 3) };
}
