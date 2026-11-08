import { readFile } from 'node:fs/promises';
import { validateTopicResearch } from '../lib/topic-research.mjs';

if (!process.argv[2]) throw new Error('Required: <Codex result.md>');
const text = await readFile(process.argv[2], 'utf8');
console.log(JSON.stringify(validateTopicResearch(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')))));
