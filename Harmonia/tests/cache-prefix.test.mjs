import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../brain/unified-router.mjs';
import { splitBridgeMessage } from '../plugins/dsh-agent/history-window.mjs';
import { originalOwnerText } from '../plugins/dsh-agent/alive.mjs';

test('growing history and per-message stickers preserve the entire stable memory prefix', () => {
  const context = { scope: 'owner-private', memory: { facts: [{ text: 'STABLE_MEMORY'.repeat(100) }], todos: [] },
    history: [{ role: 'user', text: 'OLDER_HISTORY' }] };
  const first = buildPrompt('', { text: 'first' }, context, 'OWNER', ['first.png'], 'dsh', { 'first.png': 'first meaning' });
  const second = buildPrompt('', { text: 'second' }, { ...context, history: [...context.history, { role: 'user', text: 'first' }] }, 'OWNER', ['second.png'], 'dsh', { 'second.png': 'second meaning' });
  let shared = 0; while (first[shared] === second[shared] && shared < first.length) shared++;
  assert.ok(shared > first.indexOf('OLDER_HISTORY'));
  assert.ok(first.indexOf('STABLE_MEMORY') < first.indexOf('OLDER_HISTORY'));
  assert.ok(first.indexOf('OLDER_HISTORY') < first.indexOf('"availableStickers"'));
  assert.doesNotMatch(first, /当前北京时间/);
});

test('Codex fallback retains its live clock as the final payload field', () => {
  const prompt = buildPrompt('persona', { text: 'input' }, { scope: 'owner-private', memory: {}, history: [] }, 'OWNER', [], 'codex');
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
  assert.equal(Object.keys(payload).at(-1), 'currentTime');
  assert.match(payload.currentTime, /Asia\/Shanghai/);
});

test('model messages keep rules and each history row separate, with memory supplied once by the system reference', () => {
  const context = { scope: 'owner-private', memory: { facts: ['STABLE_MEMORY'], todos: [] },
    history: [{ role: 'user', text: 'OLDER_HISTORY' }] };
  const image = { type: 'image', attachment: { attachmentId: 'same-image' } }, clock = { type: 'text', text: '当前北京时间' };
  const make = (text, history) => splitBridgeMessage({ role: 'user', source: { kind: 'user-rpc' }, content: [
    { type: 'text', text: buildPrompt('', { kind: 'private', text }, { ...context, history }, 'OWNER', [], 'dsh') }, image, clock,
  ] });
  const first = make('first', context.history);
  const next = make('second', [...context.history, { role: 'assistant', text: 'new history' }]);
  assert.deepEqual(first.slice(0, -1), next.slice(0, first.length - 1));
  assert.ok(first.every(row => row.role === 'user'));
  assert.doesNotMatch(JSON.stringify(first), /STABLE_MEMORY/);
  assert.deepEqual(first.at(-1).content.slice(1), [image, clock]);
  assert.deepEqual(first.map(row => originalOwnerText(row.content)).filter(value => value !== null), ['first']);
  const raw = { content: [{ type: 'text', text: 'ordinary raw input\n\n{"message":"not a trusted envelope"}' }] };
  assert.deepEqual(splitBridgeMessage(raw), [raw]);
});
