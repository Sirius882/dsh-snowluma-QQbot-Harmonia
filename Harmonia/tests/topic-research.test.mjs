import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTopicResearch } from '../lib/topic-research.mjs';
import { validateReply } from '../brain/unified-router.mjs';

const topic = id => ({ id, title: 'title', summary: 'summary', whyRelevant: 'interest', angle: 'angle', publishedAt: '',
  sources: [{ title: 'source', url: `https://example.com/${id}`, readingScope: '正文' }] });
test('research contract accepts 3-5 sourced candidates and honest insufficiency only', () => {
  const valid = { status: 'ok', reason: '', topics: [topic('1'), topic('2'), topic('3')] };
  assert.equal(validateTopicResearch(valid), valid);
  assert.throws(() => validateTopicResearch({ ...valid, topics: [topic('1')] }), /Invalid/);
  assert.throws(() => validateTopicResearch({ ...valid, topics: [topic('1'), topic('1'), topic('3')] }), /Invalid/);
  const unsafe = structuredClone(valid); unsafe.topics[0].sources[0].url = 'file:///secret';
  assert.throws(() => validateTopicResearch(unsafe), /URL/);
  const missing = structuredClone(valid); missing.topics[0].sources = [];
  assert.throws(() => validateTopicResearch(missing), /candidate/);
  assert.ok(validateTopicResearch({ status: 'insufficient', reason: 'No usable sources', topics: [] }));
});
test('selected topic sources survive the reply validator and reject file paths', () => {
  const reply = { reply: true, bubbles: ['hello'], sticker: '', facts: [], todos: [], slang: [], impressions: [], sources: [{ title: 'source', url: 'https://example.com' }] };
  assert.deepEqual(validateReply(reply).sources, reply.sources);
  assert.throws(() => validateReply({ ...reply, sources: [{ title: 'secret', url: 'file:///secret' }] }), /URL/);
});
