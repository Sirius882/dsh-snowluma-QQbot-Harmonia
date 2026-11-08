export function validateTopicResearch(value) {
  if (!value || !['ok', 'insufficient'].includes(value.status) || typeof value.reason !== 'string' || !Array.isArray(value.topics)
    || value.topics.length > 5 || value.status === 'ok' && value.topics.length < 3 || value.status === 'insufficient' && value.topics.length > 2) throw new Error('Invalid topic research result');
  const ids = new Set();
  for (const topic of value.topics) {
    if (!topic || ['id', 'title', 'summary', 'whyRelevant', 'angle'].some(key => typeof topic[key] !== 'string' || !topic[key].trim())
      || typeof topic.publishedAt !== 'string' || ids.has(topic.id) || !Array.isArray(topic.sources) || !topic.sources.length || topic.sources.length > 5) throw new Error('Invalid topic candidate');
    ids.add(topic.id);
    for (const source of topic.sources) {
      if (!source || typeof source.title !== 'string' || !source.title.trim() || typeof source.readingScope !== 'string' || !source.readingScope.trim()) throw new Error('Invalid topic source');
      const url = new URL(source.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid topic source URL');
    }
  }
  return value;
}
