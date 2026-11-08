import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const dshRequire = createRequire(path.join(os.homedir(), '.dsh/profiles/web/package.json'));
let PartialArguments;

export const REPLY_FORMAT_INSTRUCTION = '聊天正文直接输出普通文字，不要求整段回复是JSON；正文默认作为一条消息，不按空格或标点拆分，单条最多3800字符。需要表情、附件、记忆、来源、潜水或内部状态时，在正文末尾另起一行追加```harmonia代码块，块内只写这些字段的JSON对象；内部块不会发送给用户。需要显式多泡时在块内给bubbles:string[]（最多8条，每条最多3800字符），它替代正文；reply:false表示不发送。没有附加字段就不写块。仍兼容原来的完整回复JSON，但无需为普通文字填写空字段。';

function textReply(text, fields = {}) {
  return { reply: true, bubbles: text ? [text] : [], sticker: '', facts: [], todos: [], slang: [], impressions: [], ...fields };
}

export function parseReplyJson(text) {
  const raw = text.trim();
  const marker = /(?:^|\n)```harmonia[ \t]*(?:\r?\n|$)/.exec(raw);
  if (marker) {
    const body = raw.slice(0, marker.index).trim();
    const block = raw.slice(marker.index + marker[0].length).match(/^([\s\S]*)\r?\n```[ \t]*$/);
    try {
      if (!block || block[1].length > 1024 * 1024) throw new SyntaxError('Incomplete reply metadata');
      const fields = JSON.parse(block[1]);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SyntaxError('Invalid reply metadata');
      return textReply(body, fields);
    } catch (error) {
      if (!body) throw error;
      // Discard damaged metadata as a whole; never expose or guess internal fields.
      return textReply(body);
    }
  }
  if (raw && !/^\{|^\[\s*(?:["\[{}\d-]|true\b|false\b|null\b|\])|^```(?:json)?[ \t]*\r?\n|"(?:reply|bubbles|sticker|images|files|facts|todos|slang|impressions|memoryEdits|learnStickers|aliveUpdate|tsundereUpdate|sources)"\s*:/i.test(raw)) return textReply(raw);
  const clean = raw.replace(/^```(?:json)?[ \t]*\r?\n/i, '').replace(/\r?\n```$/, '').trim();
  try { return JSON.parse(clean); }
  catch (error) {
    if (!clean.startsWith('{') || clean.length > 1024 * 1024) throw error;
    PartialArguments ??= dshRequire('@deepseek-ai/dsh-util-values').PartialArguments;
    const partial = PartialArguments.fromText(clean);
    // Never finish partial strings, paths, memory edits or state changes by guessing their contents.
    const fields = Object.fromEntries(partial.keys().filter(key => partial.complete(key))
      .map(key => [key, partial.text(key) ?? partial.value(key)]));
    if (partial.invalid || typeof fields.reply !== 'boolean' || !Array.isArray(fields.bubbles)
      || fields.reply && !fields.bubbles.length && !fields.sticker && !fields.images?.length && !fields.files?.length) throw error;
    const value = { sticker: '', facts: [], todos: [], slang: [], impressions: [], ...fields };
    console.warn(`[dsh] Recovered incomplete reply JSON (${Object.keys(fields).length} complete fields retained); normal reply validation still applies`);
    return value;
  }
}
