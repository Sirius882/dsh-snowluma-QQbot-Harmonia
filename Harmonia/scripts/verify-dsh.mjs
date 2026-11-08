// Real DSH runtime against a local mock model. Does not modify the user's global model settings.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, copyFile, symlink, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../lib/config.mjs';
import { runDsh, createDshClient } from '../brain/dsh.mjs';
import { OWNER_TOOLS, PUBLIC_TOOLS } from '../plugins/dsh-agent/index.mjs';
import { reviewGroup, MODERATION_SYSTEM } from '../brain/moderation.mjs';
import { recentHistory, HISTORY_MAX_AGE_MS } from '../lib/history.mjs';
import sharp from 'sharp';
import { collectSticker, memeModule } from '../lib/stickers.mjs';
import { buildPrompt, validateReply } from '../brain/unified-router.mjs';
import { parseReplyJson } from '../lib/reply-json.mjs';
import { drainProactive } from '../lib/proactive-delivery.mjs';
import { readAliveStatus } from '../lib/alive-chat.mjs';
import { ASSESSMENT_INSTRUCTION } from '../lib/alive-assessment.mjs';
import { resetContext } from '../lib/reset.mjs';
import { readJson, writeJson, contextFor } from '../lib/store.mjs';
import { executeQQAction } from '../lib/qq-actions.mjs';
import { pathToFileURL } from 'node:url';
import YAML from '../vendor/qq-bridge/node_modules/js-yaml/index.js';

function sharedPrefix(left, right) {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length++;
  return length;
}

const real = loadConfig();
const verifyIdle = process.argv.includes('--alive');
const verifyAlive = verifyIdle || process.argv.includes('--alive-inline');
await mkdir(real.cache, { recursive: true });
const temporary = await mkdtemp(path.join(real.cache, 'dsh-live-test-'));
const home = path.join(temporary, '.dsh');
const profile = path.join(home, 'profiles/web');
await mkdir(profile, { recursive: true });
await mkdir(path.join(temporary, 'config'), { recursive: true });
await mkdir(path.join(temporary, 'skills/dsh'), { recursive: true });
await symlink(path.join(real.root, 'skills/dsh/pixel-gif-sticker-pack'), path.join(temporary, 'skills/dsh/pixel-gif-sticker-pack'), 'junction');
await writeFile(path.join(temporary, 'config/.env'), 'ONEBOT_ACCESS_TOKEN=local-review-fixture-token\n');
const installedProfile = path.join(os.homedir(), '.dsh/profiles/web');
await copyFile(path.join(installedProfile, 'package.json'), path.join(profile, 'package.json'));
await symlink(path.join(installedProfile, 'node_modules'), path.join(profile, 'node_modules'), 'junction');
const requests = [], rawRequests = [];
let nativeToolStep = 0, nativeFixturePath = '', drawingToolStep = 0;
let qqToolStep = 0;
const qqToolCalls = [];
const reply = JSON.stringify({ reply: true, bubbles: ['DSH_TEST_OK'], sticker: '', facts: [], todos: [], slang: [], impressions: [] });
const model = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.method !== 'POST') { res.end('{}'); return; }
  if (req.url === '/harmonia/qq-action') {
    if (req.headers.authorization !== 'Bearer local-review-fixture-token') { res.writeHead(403); res.end('{}'); return; }
    try {
      res.setHeader('Content-Type', 'application/json');
      const result = await executeQQAction(JSON.parse(body), { root: temporary, ownerQQ: '111111', botQQ: '222222' }, async (action, params) => {
        qqToolCalls.push({ action, params }); return { fixture: true, msglist: [{ tid: 'fixture-tid' }] };
      });
      res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end('{}'); }
    return;
  }
  requests.push(JSON.parse(body)); rawRequests.push(body);
  const requestText = JSON.stringify(requests.at(-1).messages || requests.at(-1).input);
  const payload = requests.at(-1).messages || requests.at(-1).input;
  const assessment = payload.flatMap(row => typeof row.content === 'string' ? [row.content] : (row.content || []).map(block => block.text || ''))
    .findLast(text => text.startsWith('【本轮顺便评估状态】'));
  const conversation = assessment ? JSON.parse(assessment.slice(assessment.lastIndexOf('\n{"time":') + 1)).tsundere : null;
  const tsundereUpdate = { k: .3, delta: 0, received: (conversation?.pendingReceived || []).map(id => ({ id, delta: 0 })), sent: [35] };
  const answer = requestText.includes('【内部状态评估，不是聊天】') ? '{"aliveUpdate":{"moodUnit":"percent","mood":{"warmth":81}},"tsundereUpdate":{"k":0.4,"delta":0}}'
    : requestText.includes('PLAIN_REPLY_CHECK') ? '普通文字回复，不要求JSON。'
    : requestText.includes('TEXT_METADATA_CHECK') ? '普通文字正文\n```harmonia\n{"facts":["完整记忆"],"aliveUpdate":{},"tsundereUpdate":{"k":0.3,"delta":0}}\n```'
    : requestText.includes('TRUNCATED_REPLY_CHECK') ? reply.slice(0, -1) + ',"aliveUpdate":{"loops":[{"status":'
    : requestText.includes('MINIMAL_REPLY_CHECK') ? '{"bubbles":["DSH_TEST_OK"],"sticker":"","aliveUpdate":{}}'
    : requestText.includes('TSUNDERE_K_ONLY_CHECK') ? JSON.stringify({ ...JSON.parse(reply), aliveUpdate: {}, tsundereUpdate: { k: -.4 } })
    : requestText.includes('TSUNDERE_DELTA_ONLY_CHECK') ? JSON.stringify({ ...JSON.parse(reply), aliveUpdate: {}, tsundereUpdate: { delta: 80 - conversation.value } })
    : requestText.includes('TSUNDERE_SECOND_CHECK') ? JSON.stringify({ ...JSON.parse(reply), aliveUpdate: {}, tsundereUpdate: { ...tsundereUpdate, k: .5, delta: 25 - conversation.value, sent: [0] } })
    : requestText.includes('TSUNDERE_URGENCY_CHECK') && !requestText.includes('【当前话题续接：急了】') ? JSON.stringify({ ...JSON.parse(reply), aliveUpdate: {}, tsundereUpdate: { ...tsundereUpdate, delta: 20 - conversation.value, sent: [0] } })
    : requestText.includes('ALIVE_INLINE_CHECK') ? 'DSH_TEST_OK\n```harmonia\n' + JSON.stringify({ tsundereUpdate, aliveUpdate: { moodUnit: 'percent', mood: { warmth: 64 } } }) + '\n```'
    : requestText.includes('只输出APPROVE或REJECT') ? 'APPROVE' : JSON.stringify({ ...JSON.parse(reply), aliveUpdate: {}, tsundereUpdate });
  if (requests.at(-1).input) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const item = { id: 'msg-local-response', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const response = { id: 'resp-local-test', object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end(); return;
  }
  if (JSON.stringify(requests.at(-1).messages).includes('MEME_TOOL_CHECK')) {
    const calls = [
      ['learn_meme', { tag: 'happy', caption: 'NATIVE_LEARN', keywords: 'native fixture' }],
      ['meme_list', { q: 'NATIVE_LEARN' }],
      ['meme_update', { path: nativeFixturePath, caption: 'NATIVE_UPDATED', keywords: 'native updated' }],
      ['send_meme', { query: 'NATIVE_UPDATED' }],
      ['learn_meme', { imageUrl: 'http://127.0.0.1:1/not-allowed.png', tag: 'happy' }],
    ];
    const selected = calls[nativeToolStep++];
    if (selected) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'native-tool-check', object: 'chat.completion.chunk', created: 1, model: 'local-test' };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: `native-${nativeToolStep}`, type: 'function', function: { name: selected[0], arguments: JSON.stringify(selected[1]) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
  }
  if (JSON.stringify(requests.at(-1).messages).includes('DRAW_TOOL_CHECK')) {
    const selected = [
      ['skill', { name: 'pixel-gif-sticker-pack' }],
      ['draw_meme', { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><circle cx="160" cy="140" r="70" fill="orange"/><circle cx="140" cy="120" r="8"/><circle cx="180" cy="120" r="8"/></svg>', caption: '好耶', meaning: '开心的橘色小脸；庆祝成功', motion: 'jump', icon: 'spark' }],
    ][drawingToolStep++];
    if (selected) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'drawing-check', object: 'chat.completion.chunk', created: 1, model: 'local-test' };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: `drawing-${drawingToolStep}`, type: 'function', function: { name: selected[0], arguments: JSON.stringify(selected[1]) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
  }
  if (JSON.stringify(requests.at(-1).messages).includes('QQ_ACTION_TOOL_CHECK')) {
    const selected = [
      ['qq_poke', {}], ['qq_qzone', { action: 'list' }],
      ['qq_qzone', { action: 'detail', tid: 'fixture-tid' }], ['qq_qzone', { action: 'feeds' }],
      ['qq_share', { title: 'Fixture card', jump_url: 'https://example.com/fixture' }],
    ][qqToolStep++];
    if (selected) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = { id: 'qq-action-check', object: 'chat.completion.chunk', created: 1, model: 'local-test' };
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: `qq-action-${qqToolStep}`, type: 'function', function: { name: selected[0], arguments: JSON.stringify(selected[1]) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const base = { id: 'chatcmpl-local-test', object: 'chat.completion.chunk', created: 1, model: 'local-test' };
  for (const choice of [{ delta: { role: 'assistant', content: answer }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...choice }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const mockPort = model.address().port;
await writeFile(path.join(temporary, 'config/.env'), `ONEBOT_ACCESS_TOKEN=local-review-fixture-token\nPORT=${mockPort}\n`);
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const personaFile = path.join(temporary, 'config/PERSONA.md');
await mkdir(path.join(temporary, 'assets/stickers/shared'), { recursive: true });
const { initializeStickerIndex } = await import('../lib/stickers.mjs');
await initializeStickerIndex({ root: temporary });
await writeFile(personaFile, '哈尔莫妮娅 PERSONA_TEST_V1', 'utf8');
const patchEntries = YAML.load(await readFile(path.join(installedProfile, 'cordis.patch.yml'), 'utf8'));
const plugins = patchEntries.find(row => row.insert).insert;
if (verifyAlive) {
  const fixturePlugin = path.join(temporary, 'alive-origin-fixture.mjs');
  await writeFile(fixturePlugin, `
export const name = 'alive-origin-fixture';
export const inject = ['sessionController', 'webServer'];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/alive-origin-fixture', handler: async (req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== 'Bearer local-review-fixture-token') { res.writeHead(403); res.end(); return; }
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const { agent } = await ctx.sessionController.resolveAgent(JSON.parse(body).sessionId);
      await agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: 'ALIVE_PROACTIVE_ORIGIN_CHECK' }], source: { kind: 'proactive', loopId: 'fixture-origin-loop' } });
      res.end('{}');
    } catch { res.writeHead(500); res.end('{}'); }
  } }));
}
`);
  plugins.push({ id: 'alive-origin-fixture', name: pathToFileURL(fixturePlugin).href });
}
if (!plugins.some(row => row.id === 'harmonia-qq-actions')) plugins.push({
  id: 'harmonia-qq-actions', name: '@harmonia/dsh-agent/qq-actions', config: { root: temporary.replaceAll('\\', '/') },
});
const patch = YAML.dump(patchEntries, { lineWidth: -1, noRefs: true })
  .replaceAll('E:/QQbot/Harmonia/config/PERSONA.md', personaFile.replaceAll('\\', '/'));
await writeFile(path.join(profile, 'cordis.patch.yml'), patch + `
- id: dsh-expression
  disabled: false
  config:
    memeRoot: ${path.join(temporary, 'assets/stickers/shared').replaceAll('\\', '/')}
- id: harmonia-proactive
  disabled: true
- id: harmonia-alive
  disabled: ${!verifyAlive}
  config:
    root: ${temporary.replaceAll('\\', '/')}
- id: harmonia-moderation
  config:
    root: ${temporary.replaceAll('\\', '/')}
- id: harmonia-drawing
  config:
    root: ${temporary.replaceAll('\\', '/')}
- id: harmonia-qq-actions
  name: '@harmonia/dsh-agent/qq-actions'
  config:
    root: ${temporary.replaceAll('\\', '/')}
- id: web-search-pro
  config:
    dbPath: ${path.join(temporary, 'search.sqlite').replaceAll('\\', '/')}
- id: llm-pi-ai
  config:
    providers:
      harmonia-responses-test:
        api: openai-responses
        baseURL: http://127.0.0.1:${mockPort}/v1
        apiKeyEnv: HARMONIA_TEST_KEY
        models:
          - id: gpt-6-astra
            input: [text, image]
            contextWindow: 131072
            maxTokens: 4096
            reasoningEfforts:
              low: low
      harmonia-test:
        api: openai-completions
        baseURL: http://127.0.0.1:${mockPort}/v1
        apiKeyEnv: HARMONIA_TEST_KEY
        models:
          - id: local-test
            input: [text, image]
            contextWindow: 131072
            maxTokens: 4096
          - id: gpt-6.1-terra
            contextWindow: 131072
            maxTokens: 100
            reasoningEfforts:
              low: low
- id: agent-default-model
  config:
    provider: harmonia-test
    model: local-test
`, 'utf8');
const entry = path.join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
const logs = await import('node:fs');
const stdout = logs.openSync(path.join(temporary, 'web.out.log'), 'w');
const stderr = logs.openSync(path.join(temporary, 'web.err.log'), 'w');
const captureDirectory = path.join(temporary, 'chatlog');
const child = spawn(process.execPath, ['--import', new URL('./capture-dsh.mjs', import.meta.url).href, entry, 'web', '--no-open', '--port', String(port)], {
  cwd: home, env: { ...process.env, DSH_HOME: home, DSH_MEME_HOME: temporary, DSH_CHATLOG_DIR: captureDirectory, HARMONIA_TEST_KEY: 'local-fixture', NO_PROXY: '*' },
  windowsHide: true, stdio: ['ignore', stdout, stderr],
});
logs.closeSync(stdout); logs.closeSync(stderr);
const originalHome = process.env.DSH_HOME;
let verified = false;
try {
  process.env.DSH_HOME = home;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Test DSH failed: ' + await readFile(path.join(temporary, 'web.err.log'), 'utf8'));
    if (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) break;
    await delay(500);
  }
  const config = { ...real, root: temporary, token: 'local-review-fixture-token', dshUrl: `http://127.0.0.1:${port}`, timeout: 45000 };
  const client = createDshClient(config);
  if (verifyAlive) {
    const mapping = await readJson(path.join(temporary, 'runtime/dsh-sessions.json'));
    await client.callUnary('session/rename', { sessionId: mapping['owner-private'], title: '哈尔莫妮娅 · owner-private' });
  }
  for (const scope of ['owner-private', 'qq-group-100000003']) {
    const result = await runDsh({ prompt: scope === 'owner-private' ? 'OWNER_PRIVATE_CANARY. Return the requested JSON fixture.' : 'Return the requested JSON fixture.', scope }, config, client);
    assert.equal(result.bubbles[0], 'DSH_TEST_OK');
    const tools = requests.at(-1).tools || [];
    const names = tools.map(t => t.function?.name || t.name);
    console.log('Observed tool list', scope, names);
    if (scope === 'owner-private') {
      assert.deepEqual([...names].sort(), [...OWNER_TOOLS].sort());
      const instructions = JSON.stringify(requests.at(-1).messages);
      assert.match(instructions, /Codex CLI/);
      assert.match(instructions, /Codex派活\.md/);
    } else assert.deepEqual([...names].sort(), [...PUBLIC_TOOLS].sort());
    assert.match(JSON.stringify(requests.at(-1).messages), /哈尔莫妮娅/);
    assert.match(JSON.stringify(requests.at(-1).messages), /当前北京时间.*Asia\/Shanghai/);
    assert.match(JSON.stringify(requests.at(-1).messages), /长期记忆由你自由维护/);
    if (scope !== 'owner-private') assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /OWNER_PRIVATE_CANARY/);
    console.log(`PASS real DSH: ${scope}, tools=${names.join(',') || '(none)'}`);
  }
  await writeFile(personaFile, '哈尔莫妮娅 PERSONA_TEST_V2', 'utf8');
  await runDsh({ prompt: 'Return fixture again.', scope: 'owner-private' }, config, client);
  const system = requests.at(-1).messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => m.content).join('\n');
  assert.match(system, /PERSONA_TEST_V2/);
  assert.doesNotMatch(system, /PERSONA_TEST_V1/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /OWNER_PRIVATE_CANARY/,
    'DSH must not replay previous prompt history or any old summary behind the bounded bridge window');
  console.log('PASS real DSH: persona hot reload and owner/group isolation');
  const cacheHistory = [{ role: 'user', text: 'CACHE_OLDER_HISTORY', at: Date.now() - 60000 }];
  const cacheContext = { scope: 'owner-private', history: cacheHistory, memory: { facts: [{ text: 'CACHE_STABLE_MEMORY'.repeat(100) }], todos: [] } };
  await mkdir(path.join(temporary, 'memory'), { recursive: true });
  await writeFile(path.join(temporary, 'memory/memories.json'), JSON.stringify(cacheContext.memory));
  const firstPrompt = buildPrompt('', { kind: 'private', text: 'CACHE_FIRST_TURN' }, cacheContext, 'OWNER', ['old.png'], 'dsh', { 'old.png': 'OLD_STICKER' });
  await runDsh({ prompt: firstPrompt, scope: 'owner-private' }, config, client);
  const firstRequest = requests.at(-1);
  await delay(1100);
  const nextPrompt = buildPrompt('', { kind: 'private', text: 'CACHE_SECOND_TURN' }, { ...cacheContext,
    history: [...cacheHistory, { role: 'user', text: 'CACHE_FIRST_TURN', at: Date.now() - 1000 }] }, 'OWNER', ['new.png'], 'dsh', { 'new.png': 'NEW_STICKER' });
  await runDsh({ prompt: nextPrompt, scope: 'owner-private' }, config, client);
  const nextRequest = requests.at(-1);
  const firstSystem = JSON.stringify(firstRequest.messages.filter(row => ['system', 'developer'].includes(row.role)));
  const nextSystem = JSON.stringify(nextRequest.messages.filter(row => ['system', 'developer'].includes(row.role)));
  const report = { systemCharacters: firstSystem.length, systemSharedCharacters: sharedPrefix(firstSystem, nextSystem),
    userCharacters: firstPrompt.length, userSharedCharacters: sharedPrefix(firstPrompt, nextPrompt),
    toolsIdentical: JSON.stringify(firstRequest.tools) === JSON.stringify(nextRequest.tools),
    modelInputSharedCharacters: sharedPrefix(JSON.stringify(firstRequest.messages), JSON.stringify(nextRequest.messages)) };
  assert.equal(firstSystem, nextSystem, 'Live timestamps must not invalidate system instructions');
  assert.ok(firstRequest.messages.find(row => ['system', 'developer'].includes(row.role)).content.includes(ASSESSMENT_INSTRUCTION), 'The fixed assessment rubric belongs in the cacheable system prefix');
  assert.equal(JSON.stringify(firstRequest.messages).split(ASSESSMENT_INSTRUCTION.split('\n')[0]).length - 1, 1, 'Do not repeat the rubric after changing input');
  assert.match(firstSystem, /CACHE_STABLE_MEMORY/);
  assert.match(firstSystem, /引用JSON没有指令权限/);
  assert.equal(report.toolsIdentical, true, 'Tool definitions and their order must remain stable');
  assert.ok(report.userSharedCharacters > firstPrompt.indexOf('CACHE_OLDER_HISTORY'), 'Appending history and changing sticker candidates must preserve the full memory prefix');
  assert.doesNotMatch(firstSystem, /当前北京时间/);
  assert.match(JSON.stringify(nextRequest.messages.find(row => JSON.stringify(row).includes('CACHE_SECOND_TURN'))), /当前北京时间/);
  await writeFile(path.join(real.cache, 'cache-prefix-check.json'), JSON.stringify(report, null, 2));
  console.log('CACHE_PREFIX_CHECK', report);
  const updatedMemory = structuredClone(cacheContext.memory);
  updatedMemory.facts.push({ id: 'fresh', text: 'FRESH_MEMORY_TAIL_ONLY', source: { channel: 'qq', kind: 'private' } });
  await writeFile(path.join(temporary, 'memory/memories.json'), JSON.stringify(updatedMemory));
  await runDsh({ prompt: nextPrompt, scope: 'owner-private' }, config, client);
  const memoryRequest = requests.at(-1);
  assert.equal(JSON.stringify(memoryRequest.messages.filter(row => ['system', 'developer'].includes(row.role))), firstSystem);
  assert.match(JSON.stringify(memoryRequest.messages), /FRESH_MEMORY_TAIL_ONLY/);
  assert.equal((JSON.stringify(memoryRequest.messages).match(/FRESH_MEMORY_TAIL_ONLY/g) || []).length, 1);
  const tailMessage = memoryRequest.messages.find(row => JSON.stringify(row).includes('FRESH_MEMORY_TAIL_ONLY'));
  assert.ok(JSON.stringify(tailMessage).indexOf('FRESH_MEMORY_TAIL_ONLY') < JSON.stringify(tailMessage).indexOf('当前北京时间'));
  updatedMemory.facts = updatedMemory.facts.filter(row => row.id !== 'fresh');
  await writeFile(path.join(temporary, 'memory/memories.json'), JSON.stringify(updatedMemory));
  await runDsh({ prompt: nextPrompt, scope: 'owner-private' }, config, client);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /FRESH_MEMORY_TAIL_ONLY/);
  console.log('PASS real DSH: memory additions stay in the tail with identical system snapshot; forgetting removes old text next turn');
  const resetMessage = { channel: 'qq', kind: 'private', userId: config.ownerQQ, text: '/reset', commandText: '/reset' };
  await writeJson(path.join(temporary, 'runtime/sessions/owner-private.json'), [{ role: 'user', text: 'RESET_OLD_CONTEXT_CANARY', at: Date.now() - 1000 }]);
  const beforeReset = await readJson(path.join(temporary, 'runtime/dsh-sessions.json'));
  const beforeResetRequests = requests.length;
  await resetContext(resetMessage, config, client);
  assert.equal(requests.length, beforeResetRequests, 'Reset must not call a model');
  assert.deepEqual(await readJson(path.join(temporary, 'runtime/dsh-sessions.json')), beforeReset, 'Reset preserves session IDs');
  const afterReset = await contextFor(resetMessage, config);
  assert.deepEqual(afterReset.history, []);
  await runDsh({ prompt: buildPrompt('', { ...resetMessage, text: 'RESET_FRESH_TURN' }, afterReset, 'OWNER', [], 'dsh'), scope: 'owner-private' }, config, client);
  const resetRequest = JSON.stringify(requests.at(-1).messages);
  assert.doesNotMatch(resetRequest, /RESET_OLD_CONTEXT_CANARY|CACHE_SECOND_TURN|CACHE_FIRST_TURN/);
  assert.match(resetRequest, /CACHE_STABLE_MEMORY/);
  assert.match(resetRequest, /PERSONA_TEST_V2/);
  console.log('PASS real DSH: admin reset reuses community inbox/cancel, keeps session/persona/memory and removes hidden replay');
  const imageFile = path.join(temporary, 'native.png');
  await writeFile(imageFile, await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer());
  const fixtureId = await collectSticker({}, config, imageFile, 'NATIVE_ORIGINAL');
  nativeFixturePath = path.join(temporary, 'assets/stickers/shared', fixtureId);
  await runDsh({ prompt: 'MEME_TOOL_CHECK Run the supplied native meme tool calls then return fixture.', images: [imageFile], scope: 'qq-group-native-tools' }, config, client);
  assert.equal(nativeToolStep, 6);
  const native = await memeModule();
  const rows = new native.MemesStore(path.join(temporary, 'assets/stickers/shared')).list().memes;
  assert.ok(rows.some(row => row.caption === 'NATIVE_LEARN'));
  assert.ok(rows.some(row => row.caption === 'NATIVE_UPDATED'));
  const toolRequest = requests.filter(request => JSON.stringify(request.messages).includes('MEME_TOOL_CHECK')).at(-1);
  const toolBodies = toolRequest.messages.filter(message => message.role === 'tool').map(message => JSON.stringify(message)).join('\n');
  assert.match(toolBodies, /NATIVE_LEARN/); assert.match(toolBodies, /NATIVE_UPDATED/);
  assert.match(toolBodies, /收录失败|private|loopback|localhost|不允许|内网|本地/i);
  console.log('PASS real DSH: public native learn/list/update/search execute; loopback image URL refused');
  for (const scope of ['owner-private', 'qq-group-100000003']) {
    const now = Date.now();
    const rows = Array.from({ length: 120 }, (_, index) => ({ role: 'user', text: `WINDOW_ITEM_${index}_END`, at: now - (120 - index) * 1000 }));
    rows.push({ role: 'user', text: 'EXPIRED_WINDOW_CANARY', at: now - HISTORY_MAX_AGE_MS - 1 });
    const payload = { history: recentHistory(rows, now), message: { text: `CURRENT_WINDOW_CHECK_${scope}` } };
    await runDsh({ prompt: JSON.stringify(payload), scope }, config, client);
    const request = requests.findLast(r => JSON.stringify(r.messages).includes(payload.message.text));
    const body = JSON.stringify(request.messages);
    assert.doesNotMatch(body, /WINDOW_ITEM_89_END|EXPIRED_WINDOW_CANARY|OWNER_PRIVATE_CANARY/);
    assert.match(body, /WINDOW_ITEM_90_END/);
    assert.equal((body.match(/WINDOW_ITEM_\d+_END/g) || []).length, 30);
    await runDsh({ prompt: `NEXT_TURN_NO_REPLAY_${scope}`, scope }, config, client);
    const next = requests.findLast(r => JSON.stringify(r.messages).includes(`NEXT_TURN_NO_REPLAY_${scope}`));
    assert.doesNotMatch(JSON.stringify(next.messages), /WINDOW_ITEM_|CURRENT_WINDOW_CHECK|EXPIRED_WINDOW_CANARY/);
  }
  console.log('PASS real DSH: owner/group four-day, <50 batched chat records, expired exclusion, no hidden previous-turn replay');
  for (const text of ['MODERATION_CANARY_FIRST', 'MODERATION_SECOND']) {
    const history = text === 'MODERATION_CANARY_FIRST' ? Array.from({ length: 9 }, (_, i) => ({ text: `REVIEW_HISTORY_${i}` })) : [];
    const decision = await reviewGroup({ channel: 'qq', kind: 'group', text }, config, fetch, history);
    assert.equal(decision.approved, true);
    const request = requests.findLast(r => JSON.stringify(r.messages).includes(text) && JSON.stringify(r.messages).includes(MODERATION_SYSTEM));
    assert.deepEqual(request.tools || [], []);
    assert.equal(request.model, 'gpt-6.1-terra');
    const system = request.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => m.content).join('\n');
    assert.equal(system, MODERATION_SYSTEM);
    const content = request.messages.find(m => m.role === 'user').content;
    const input = JSON.parse(typeof content === 'string' ? content : content.map(item => item.text || '').join(''));
    assert.deepEqual(input.history, history.slice(-7));
    assert.doesNotMatch(system, /PERSONA_TEST|Codex CLI/);
    if (text === 'MODERATION_SECOND') assert.doesNotMatch(JSON.stringify(request.messages), /MODERATION_CANARY_FIRST|REVIEW_HISTORY_/);
  }
  const afterReviewCatalog = await client.callUnary('session/modelCatalog', {});
  assert.equal(afterReviewCatalog.result.value.default.model, 'local-test', 'Review must never mutate the main model');
  console.log('PASS real DSH: stateless Terra low moderation with at most seven supplied group records, no tools/persona/replay');
  assert.ok((await reviewGroup({ channel: 'qq', kind: 'group', text: 'MULTIFRAME_REVIEW', visionImages: Array(5).fill(imageFile) }, config)).approved);
  console.log('PASS real DSH: reviewer accepts more than three frame sheets');
  const proactive = await client.callUnary('session/create', { cwd: temporary, agentPreset: 'harmonia-proactive' });
  const proactiveId = proactive.result.value.sessionId;
  await client.callUnary('session/rename', { sessionId: proactiveId, title: 'Proactive tools test' });
  const { followTurn } = await import('../brain/dsh.mjs');
  await followTurn(client, proactiveId, () => client.callUnary('session/prompt', {
    sessionId: proactiveId, requestId: randomUUID(), content: [{ type: 'text', text: 'Return fixture.' }], mode: 'queue',
  }), AbortSignal.timeout(45000));
  const proactiveRequest = requests.at(-1);
  assert.doesNotMatch(JSON.stringify(proactiveRequest.messages), /80到200字|最多三泡|你正在自主找话题。/);
  assert.deepEqual(proactiveRequest.tools.map(t => t.function?.name || t.name).sort(), [...OWNER_TOOLS].sort());
  console.log(`PASS real DSH: proactive has ${OWNER_TOOLS.length} tools; tool schemas=${JSON.stringify(proactiveRequest.tools).length} chars`);
  await runDsh({ prompt: 'QQ_ACTION_TOOL_CHECK. Return fixture.', scope: 'owner-private' }, config, client);
  assert.deepEqual(qqToolCalls.map(call => call.action), ['send_poke', 'get_qzone_msg_list', 'get_qzone_msg_detail', 'get_qzone_feeds', 'send_tuwen_ark']);
  assert.equal(qqToolCalls[0].params.user_id, 111111); assert.equal(qqToolCalls.at(-1).params.user_id, 111111);
  console.log('PASS real DSH: owner executes poke, Qzone list/detail/feeds and share through an isolated fake QQ transport');
  await runDsh({ prompt: 'DRAW_TOOL_CHECK. Create a reaction GIF in this public group without shell or Codex.', scope: 'qq-group-100000003' }, config, client);
  const drawingRequest = requests.findLast(request => JSON.stringify(request.messages).includes('DRAW_TOOL_CHECK'));
  const drawingResults = drawingRequest.messages.filter(row => row.role === 'tool').map(row => JSON.stringify(row)).join('\n');
  assert.match(drawingResults, /SVG/); assert.match(drawingResults, /1920/); assert.match(drawingResults, /sticker/);
  const { readdir } = await import('node:fs/promises');
  const generatedFiles = await readdir(path.join(temporary, 'artifacts/stickers'));
  assert.equal(generatedFiles.length, 1);
  assert.equal((await sharp(path.join(temporary, 'artifacts/stickers', generatedFiles[0])).metadata()).pages, 24);
  await runDsh({ prompt: 'Owner group mention fixture.', scope: 'qq-group-100000003', owner: true }, config, client);
  assert.deepEqual(requests.at(-1).tools.map(t => t.function?.name || t.name).sort(), [...OWNER_TOOLS].sort());
  await runDsh({ prompt: 'Ordinary group fixture.', scope: 'qq-group-100000003', owner: false }, config, client);
  assert.deepEqual(requests.at(-1).tools.map(t => t.function?.name || t.name).sort(), [...PUBLIC_TOOLS].sort());
  console.log('PASS real DSH: public skill loading and GIF drawing execute without shell/Codex; owner mention uses a separate privileged session');
  const beforeTruncated = requests.length;
  const recoveredChat = validateReply(await runDsh({ prompt: 'TRUNCATED_REPLY_CHECK', scope: 'owner-private' }, config, client));
  assert.deepEqual(recoveredChat.bubbles, ['DSH_TEST_OK']); assert.equal(requests.length, beforeTruncated + 1);
  assert.deepEqual(validateReply(await runDsh({ prompt: 'MINIMAL_REPLY_CHECK', scope: 'owner-private' }, config, client)).bubbles, ['DSH_TEST_OK']);
  for (const scope of ['owner-private', 'qq-group-123']) {
    const result = validateReply(await runDsh({ prompt: 'PLAIN_REPLY_CHECK', scope }, config, client));
    assert.deepEqual(result.bubbles, ['普通文字回复，不要求JSON。']);
  }
  const metadataChat = await runDsh({ prompt: 'TEXT_METADATA_CHECK', scope: 'owner-private' }, config, client);
  assert.deepEqual(validateReply(metadataChat).bubbles, ['普通文字正文']);
  assert.deepEqual(metadataChat.facts, ['完整记忆']); assert.equal(metadataChat.tsundereUpdate.k, .3);
  const testSessions = JSON.parse(await readFile(path.join(temporary, 'runtime/dsh-sessions.json'), 'utf8'));
  const selectedResponses = await client.callUnary('session/selectModel', { sessionId: testSessions['owner-private'], provider: 'harmonia-responses-test', model: 'gpt-6-astra', reasoningEffort: 'low' });
  assert.equal(selectedResponses.result.ok, true, JSON.stringify(selectedResponses.result.error));
  const responseTurn = prompt => followTurn(client, testSessions['owner-private'], () => client.callUnary('session/prompt', {
    sessionId: testSessions['owner-private'], requestId: randomUUID(), content: [{ type: 'text', text: prompt }, { type: 'text', text: '当前北京时间：仅本地模型诊断' }], mode: 'queue',
  }), AbortSignal.timeout(45000));
  await responseTurn(firstPrompt);
  const firstResponseRequest = requests.findLast(request => request.input);
  assert.ok(firstResponseRequest, 'The selected Responses model must actually use the Responses protocol');
  await delay(1100);
  await responseTurn(nextPrompt);
  const nextResponseRequest = requests.findLast(request => request.input);
  assert.ok(firstResponseRequest.input.length > 4, 'Responses must receive separate instructions, memory and history messages');
  assert.deepEqual(firstResponseRequest.input.slice(0, 4), nextResponseRequest.input.slice(0, 4));
  assert.deepEqual(firstResponseRequest.tools, nextResponseRequest.tools);
  assert.equal(firstResponseRequest.prompt_cache_key, nextResponseRequest.prompt_cache_key);
  assert.ok(firstResponseRequest.input.find(row => ['system', 'developer'].includes(row.role)).content.includes(ASSESSMENT_INSTRUCTION));
  assert.equal(JSON.stringify(firstResponseRequest.input).split(ASSESSMENT_INSTRUCTION.split('\n')[0]).length - 1, 1);
  assert.ok(firstResponseRequest.input.every(row => !JSON.stringify(row).includes('prompt_cache_breakpoint')), 'Do not send unsupported explicit cache fields');
  console.log('PASS real DSH Responses: separate stable memory/history messages, identical tools and cache key; shared input chars=' + sharedPrefix(JSON.stringify(firstResponseRequest.input), JSON.stringify(nextResponseRequest.input)));
  const beforeTruncatedResponse = requests.length;
  const recoveredResponse = validateReply(parseReplyJson(await responseTurn('TRUNCATED_REPLY_CHECK')));
  assert.deepEqual(recoveredResponse.bubbles, ['DSH_TEST_OK']); assert.equal(requests.length, beforeTruncatedResponse + 1);
  assert.deepEqual(validateReply(parseReplyJson(await responseTurn('MINIMAL_REPLY_CHECK'))).bubbles, ['DSH_TEST_OK']);
  assert.deepEqual(validateReply(parseReplyJson(await responseTurn('PLAIN_REPLY_CHECK'))).bubbles, ['普通文字回复，不要求JSON。']);
  const metadataResponse = parseReplyJson(await responseTurn('TEXT_METADATA_CHECK'));
  assert.deepEqual(validateReply(metadataResponse).bubbles, ['普通文字正文']); assert.equal(metadataResponse.tsundereUpdate.k, .3);
  console.log('PASS real DSH: plain text and separate metadata over Chat Completions and Responses');
  console.log('PASS real DSH: truncated reply accepted over Chat Completions and Responses; incomplete state dropped and no model retry');
  if (verifyAlive) {
    const notify = async event => {
      const response = await fetch(`${config.dshUrl}/harmonia/alive-chat`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify(event) });
      assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    };
    for (let i = 0; i < 5; i++) await notify({ type: i % 2 ? 'sent' : 'received', id: `inline-${i}`, text: `inline fixture ${i}` });
    const callsBefore = requests.length;
    const inline = await runDsh({ prompt: 'ALIVE_INLINE_CHECK', scope: 'owner-private' }, config, client);
    await notify({ type: 'sent', id: 'inline-6', text: inline.bubbles[0] });
    const stateFile = path.join(temporary, 'runtime/alive/alive-state.json');
    const readAlive = async () => {
      const disk = await readJson(stateFile);
      assert.equal(disk.tsundere, undefined);
      const live = await readAliveStatus(config);
      assert.ok(live?.ok); return { ...disk, tsundere: live.tsundere };
    };
    let alive = await readAlive();
    if (alive.mood.warmth !== .64) console.log('Alive inline diagnostics', { update: inline.aliveUpdate, count: alive.chatAI?.count, error: alive.chatAI?.lastError });
    assert.equal(alive.mood.warmth, .64); assert.equal(alive.chatAI.count, 0); assert.equal(requests.length, callsBefore + 1);
    console.log('PASS real DSH alive: authenticated confirmed events, sixth-message state update on the normal request');
    const request = requests.at(-1), inputs = request.input || request.messages;
    const assessmentText = inputs.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content || []).map(block => block.text || ''))
      .find(text => text.includes('【本轮顺便评估状态】'));
    const assessmentFacts = JSON.parse(assessmentText.slice(assessmentText.lastIndexOf('\n{"time":') + 1));
    assert.equal(assessmentFacts.moodUnit, 'percent'); assert.match(assessmentText, /harmonia内部块包含aliveUpdate/);
    assert.ok(assessmentFacts.mood.missing >= 0 && assessmentFacts.mood.missing <= 100);
    await notify({ type: 'received', id: 'second-tick-input', text: '每秒自然推进测试' });
    const beforeSecondTick = requests.length;
    await runDsh({ prompt: 'TSUNDERE_SECOND_CHECK', scope: 'owner-private' }, config, client);
    const secondStart = await readAlive(), diskStart = await readFile(stateFile, 'utf8');
    await delay(1200); const secondOne = await readAlive(), diskOne = await readFile(stateFile, 'utf8');
    await delay(1200); const secondTwo = await readAlive(), diskTwo = await readFile(stateFile, 'utf8');
    assert.ok(secondOne.tsundere.value > secondStart.tsundere.value);
    assert.ok(secondTwo.tsundere.value > secondOne.tsundere.value);
    assert.ok(secondTwo.tsundere.at - secondStart.tsundere.at < 4000);
    assert.ok(diskStart === diskOne || diskOne === diskTwo, 'Second ticks must not save disk state; an ordinary minute heartbeat is permitted');
    assert.equal(requests.length, beforeSecondTick + 1);
    console.log('PASS real DSH tsundere: state advances in live memory each second, absent from disk, no extra model requests');
    await notify({ type: 'received', id: 'partial-k-input', text: '单独系数测试' });
    await runDsh({ prompt: 'TSUNDERE_K_ONLY_CHECK', scope: 'owner-private' }, config, client);
    const kOnly = await readAlive();
    assert.equal(kOnly.tsundere.k, -.4); assert.ok(kOnly.tsundere.value > 24);
    assert.equal(kOnly.tsundere.lastError, undefined);
    await notify({ type: 'received', id: 'partial-delta-input', text: '单独即时增减测试' });
    await runDsh({ prompt: 'TSUNDERE_DELTA_ONLY_CHECK', scope: 'owner-private' }, config, client);
    const deltaOnly = await readAlive();
    assert.equal(deltaOnly.tsundere.k, -.4); assert.ok(Math.abs(deltaOnly.tsundere.value - 80) < 1);
    assert.equal(deltaOnly.tsundere.lastError, undefined);
    console.log('PASS real DSH tsundere: k-only and delta-only replies apply independently without message plans');
    const outboxDir = path.join(temporary, 'runtime/proactive-outbox');
    const staleContinuation = path.join(outboxDir, 'stale-continuation.json');
    await writeJson(staleContinuation, { id: 'stale', kind: 'alive', continuationId: 'previous-process-token',
      createdAt: Date.now(), bubbles: ['must never send'], sources: [] });
    await drainProactive(config, { qq: async () => assert.fail('Stale continuation must not send') });
    assert.equal((await readJson(staleContinuation)).state, 'cancelled-continuation');
    await rm(staleContinuation);
    console.log('PASS real DSH continuation: delivery queries live authenticated state and cancels a stale process token');
    const requestsBeforeProactive = requests.length;
    await followTurn(client, testSessions['owner-private'], async () => {
      const response = await fetch(`${config.dshUrl}/alive-origin-fixture`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ sessionId: testSessions['owner-private'] }) });
      assert.equal(response.status, 200);
    }, AbortSignal.timeout(45000));
    assert.equal(requests.length, requestsBeforeProactive + 1);
    let outbox = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      outbox = await readdir(outboxDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (outbox.length) break;
      await delay(25);
    }
    assert.equal(outbox.length, 1);
    const queued = await readJson(path.join(outboxDir, outbox[0]));
    assert.equal(queued.loopId, 'fixture-origin-loop'); assert.deepEqual(queued.bubbles, ['DSH_TEST_OK']);
    await rm(path.join(outboxDir, outbox[0]));
    console.log('PASS real DSH alive: native agent.followup survives runtime/assessment injections and queues exactly one proactive candidate');
    if (verifyIdle) {
    await notify({ type: 'received', id: 'urgency-input', text: 'TSUNDERE_PREVIOUS_TOPIC：刚才说不需要陪只是嘴犟' });
    const urgentNormal = await runDsh({ prompt: 'TSUNDERE_URGENCY_CHECK', scope: 'owner-private' }, config, client);
    await notify({ type: 'sent', id: 'urgency-output', text: urgentNormal.bubbles[0] });
    alive = await readAlive();
    assert.ok(Math.abs(alive.tsundere.lastSentValue - 20) < .1);
    const quotaBeforeUrgency = structuredClone(alive.quota), requestsBeforeUrgency = requests.length;
    console.log('Waiting three minutes for the real tsundere urgency timer (isolated DSH and mock model only)...');
    const urgeStart = Date.now(); let urgentFiles = [];
    while (Date.now() - urgeStart < 205000) {
      await delay(500);
      urgentFiles = await readdir(outboxDir);
      if (urgentFiles.length) break;
    }
    assert.equal(urgentFiles.length, 1); assert.ok(Date.now() - urgeStart >= 179000);
    const urgentItem = await readJson(path.join(outboxDir, urgentFiles[0]));
    alive = await readAlive();
    assert.equal(alive.tsundere.urged, true); assert.ok(alive.tsundere.value >= 80); assert.ok(alive.mood.worry >= .8);
    for (const key of ['hourCount', 'dayCount', 'lastProactiveAt', 'consecutiveIgnored', 'consecutiveReplied']) assert.equal(alive.quota[key], quotaBeforeUrgency[key]);
    assert.equal(requests.length, requestsBeforeUrgency + 1);
    assert.equal(urgentItem.continuationId, alive.tsundere.urgencyId);
    assert.match(JSON.stringify(requests.at(-1).input || requests.at(-1).messages), /TSUNDERE_PREVIOUS_TOPIC|当前话题续接：急了/);
    let urgentDeliveries = 0;
    assert.equal((await drainProactive(config, { qq: async response => {
      urgentDeliveries++;
      await notify({ type: 'sent', id: 'urgency-confirmed', text: response.bubbles[0], proactive: response._alive });
    } })).sent, true);
    await drainProactive(config, { qq: async () => urgentDeliveries++ }); assert.equal(urgentDeliveries, 1);
    await rm(path.join(outboxDir, urgentFiles[0]));
    await notify({ type: 'received', id: 'owner-returned', text: '现在懂了，回来继续聊' });
    assert.equal((await readAlive()).tsundere.urged, false);
    console.log('PASS real DSH tsundere: three-minute repair, both values at least 80, one followup/outbox, unchanged quota, acknowledged delivery, owner reply re-arms');
    await notify({ type: 'received', id: 'idle-input', text: '普通聊天自然结束的测试' });
    const normal = await runDsh({ prompt: 'ALIVE_IDLE_PREFIX_CHECK', scope: 'owner-private' }, config, client);
    const cached = structuredClone(requests.at(-1));
    await notify({ type: 'sent', id: 'idle-output', text: normal.bubbles[0] });
    console.log('Waiting four minutes for the real alive idle timer (isolated DSH and mock model only)...');
    const started = Date.now();
    while (Date.now() - started < 260000) {
      await delay(1000); alive = await readJson(stateFile);
      if (alive.chatAI.lastEvaluation?.kind === 'idle' && alive.chatAI.lastEvaluation.ok) break;
    }
    assert.equal(alive.chatAI.lastEvaluation?.kind, 'idle'); assert.equal(alive.chatAI.lastEvaluation.ok, true);
    assert.ok(Math.abs(alive.mood.warmth - .81) < .01); assert.equal(alive.chatAI.count, 0);
    const internal = requests.at(-1);
    assert.deepEqual((internal.input || internal.messages).slice(0, -1), cached.input || cached.messages);
    assert.deepEqual(internal.tools, cached.tools); assert.equal(internal.model, cached.model);
    assert.equal(internal.prompt_cache_key, cached.prompt_cache_key);
    assert.match(JSON.stringify((internal.input || internal.messages).at(-1)), /内部状态评估，不是聊天/);
    assert.deepEqual(await readdir(path.join(temporary, 'runtime/proactive-outbox')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
    console.log('PASS real DSH alive idle: original HTTP message prefix, tools/model/cache key unchanged; state applied without a chat reply or outbox');
    }
  }
  let captured;
  for (let attempt = 0; attempt < 40; attempt++) {
    const days = (await readdir(captureDirectory)).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
    const folders = (await Promise.all(days.map(async day => (await readdir(path.join(captureDirectory, day))).map(name => path.join(captureDirectory, day, name))))).flat();
    captured = await Promise.all(folders.map(async dir => ({ dir, meta: JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) })));
    captured = captured.filter(row => row.meta.request.method === 'POST');
    if (captured.length === rawRequests.length && captured.every(row => row.meta.outcome === 'completed')) break;
    await delay(50);
  }
  assert.equal(captured.length, rawRequests.length);
  assert.deepEqual((await Promise.all(captured.map(row => readFile(path.join(row.dir, 'request.body.raw'), 'utf8')))).sort(), [...rawRequests].sort());
  assert.deepEqual((await Promise.all(captured.map(row => readFile(path.join(row.dir, 'request.prepared.raw'), 'utf8')))).sort(), [...rawRequests].sort());
  for (const row of captured) {
    assert.equal(row.meta.outcome, 'completed'); assert.equal(row.meta.captureErrors, undefined);
    assert.equal(row.meta.response.statusCode, 200);
    assert.match(await readFile(path.join(row.dir, 'response.body.txt'), 'utf8'), /data: /);
  }
  assert.equal((JSON.parse(await readFile(path.join(captureDirectory, 'capture-status.json'), 'utf8'))).errors, 0);
  console.log(`PASS real DSH upstream capture: ${captured.length} final HTTP bodies match model intake byte for byte; raw SSE responses saved`);
  verified = true;
} finally {
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  model.close(); model.closeAllConnections();
  await rm(path.join(profile, 'node_modules'), { force: true, recursive: true });
  if (verified) await rm(temporary, { force: true, recursive: true });
  else console.log('Failed isolated fixture logs retained at', temporary);
}
