import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { MODERATION_SYSTEM, approved } from '../../brain/moderation.mjs';

export const name = 'harmonia-moderation';
export const inject = ['llm', 'agentDefaultModel', 'attachments', 'webServer'];
export async function moderateContent(ctx, content, signal) {
  const provider = ctx.agentDefaultModel.currentSelection().provider;
  const prepared = await ctx.attachments.admitPromptContent(content);
  let text = '';
  // One-shot call: only the supplied group context, without persona, tools or global selection mutation.
  for await (const chunk of ctx.llm.stream({ provider, model: 'gpt-6.1-terra', reasoningEffort: 'low',
    system: MODERATION_SYSTEM, messages: [{ role: 'user', content: prepared }], tools: [], maxTokens: 1024, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'error') throw new Error('Reviewer inference failed');
    if (text.length > 128) return 'REJECT';
  }
  return approved(text) ? 'APPROVE' : 'REJECT';
}
export function apply(ctx, config) {
  const token = parseEnv(readFileSync(path.join(config.root, 'config/.env'), 'utf8')).ONEBOT_ACCESS_TOKEN;
  let pending = 0;
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/harmonia/moderate', handler: async (req, res) => {
    const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(req.headers.authorization || '');
    if (req.method !== 'POST' || req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected) || !token || pending >= 3) { res.writeHead(403); res.end('{}'); return; }
    pending++;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 40000);
    res.once('close', () => controller.abort());
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 52 * 1024 * 1024) throw new Error('Review input too large'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(data.content) || data.content.length > 385 || data.content.some(x => !['text', 'image'].includes(x?.type))) throw new Error('Invalid reviewer input');
      const decision = await moderateContent(ctx, data.content, controller.signal);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ decision }));
    } catch { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"decision":"REJECT"}'); }
    finally { clearTimeout(timer); pending--; }
  } }));
}
