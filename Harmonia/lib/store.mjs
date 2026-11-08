import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CACHE } from './config.mjs';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { recentHistory } from './history.mjs';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e; }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.join(CACHE, 'atomic'), { recursive: true });
  const temporary = path.join(CACHE, 'atomic', `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export function writeJsonSync(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.join(CACHE, 'atomic'), { recursive: true });
  const temporary = path.join(CACHE, 'atomic', `${randomUUID()}.tmp`);
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

export function identity(message, config) {
  const owner = message.channel === 'qq' ? config.ownerQQ : config.ownerWechat;
  return owner && String(message.userId) === owner ? 'OWNER' : 'GUEST';
}
export function ownerAccess(message, config) {
  return identity(message, config) === 'OWNER' && (message.kind === 'private'
    || message.channel === 'qq' && message.kind === 'group' && message.mentioned === true);
}
export function allowed(message, config) {
  if (!['qq', 'wechat'].includes(message.channel) || !['private', 'group'].includes(message.kind)) return false;
  if (message.channel === 'wechat' && message.kind !== 'private') return false;
  if (message.kind === 'group') return config.groups.includes(String(message.groupId));
  if (identity(message, config) === 'OWNER') return true;
  return (message.channel === 'qq' ? config.qqUsers : config.wechatUsers).includes(String(message.userId));
}
export function scopeFor(message, config) {
  if (message.kind === 'group') return `qq-group-${message.groupId}`;
  if (identity(message, config) === 'OWNER') return 'owner-private';
  return `${message.channel}-private-${Buffer.from(String(message.userId)).toString('hex')}`;
}
export const EMPTY_MEMORY = { version: 2, facts: [], todos: [] };
export const memoryFile = config => path.join(config.root, 'memory/memories.json');
export function memorySource(message) {
  return Object.fromEntries(['channel', 'kind', 'groupId', 'userId', 'id', 'at'].filter(key => message[key] !== undefined)
    .map(key => [key === 'id' ? 'messageId' : key, message[key]]));
}

export async function contextFor(message, config) {
  const scope = scopeFor(message, config);
  const history = recentHistory(await readJson(path.join(config.root, 'runtime/sessions', `${scope}.json`), []));
  const memory = await readJson(memoryFile(config), EMPTY_MEMORY);
  return { scope, history, memory };
}
