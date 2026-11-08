import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from '../vendor/qq-bridge/node_modules/js-yaml/index.js';
import { ROOT } from '../lib/config.mjs';

const profile = path.join(os.homedir(), '.dsh/profiles/web');
const file = path.join(profile, 'cordis.patch.yml');
const entries = YAML.load(await readFile(file, 'utf8'));
const old = entries.find(x => x.insert)?.insert;
if (!old) throw new Error('Harmonia profile entries missing');
for (const row of old.filter(x => ['preset-harmonia-owner', 'preset-harmonia-public', 'preset-harmonia-proactive'].includes(x.id))) {
  if (row.id === 'preset-harmonia-owner') {
    row.config.name = '哈尔莫妮娅（主人权限）';
    row.config.description = '主人私聊或主人群内直接@；保留当前聊天历史与接收目标，工程任务派给Codex，表情在DSH直接制作。';
  } else if (row.id === 'preset-harmonia-public') row.config.description = '群聊和访客使用各自历史、共享记忆及表情搜索/制作；没有通用磁盘、命令和网页权限。';
  row.config.plugins = row.config.plugins.filter(p => p.name !== '@deepseek-ai/dsh-compaction-basic');
  if (!row.config.plugins.some(p => p.id === 'harmonia-compaction')) row.config.plugins.unshift({
    id: 'harmonia-compaction', name: 'cordis:group', group: true, isolate: { compaction: true },
    config: [{ name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.7, headroomTokens: 8192,
      retainRatio: 0.12, maxTokens: 4096, maxOverflowRetries: 0 } }],
  });
  const group = row.config.plugins.find(p => p.id === 'harmonia-compaction');
  for (const plugin of group.config) if (plugin.name === '@deepseek-ai/dsh-compaction-basic') plugin.config.auto = false;
  const agent = row.config.plugins.find(p => p.name === '@harmonia/dsh-agent');
  if (agent?.config) {
    delete agent.config.ownerMemoryFile;
    delete agent.config.researchFile;
  }
  if (!row.config.plugins.some(p => p.id === 'harmonia-skills')) row.config.plugins.push({
    id: 'harmonia-skills', name: 'cordis:group', group: true, isolate: { skills: true }, config: [
      { name: '@deepseek-ai/dsh-skill' },
      { name: '@deepseek-ai/dsh-skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: [path.join(ROOT, 'skills/dsh').replaceAll('\\', '/')] } },
      { name: '@deepseek-ai/dsh-tool-skill' },
    ],
  });
}
function add(row) { const index = old.findIndex(x => x.id === row.id); if (index < 0) old.push(row); else old[index] = row; }
const reviewerPreset = old.find(x => x.id === 'preset-harmonia-moderator'); if (reviewerPreset) reviewerPreset.disabled = true;
add({ id: 'harmonia-moderation', name: '@harmonia/dsh-agent/moderation', config: { root: ROOT.replaceAll('\\', '/') } });
add({ id: 'harmonia-alive', name: '@harmonia/dsh-agent/alive', config: { root: ROOT.replaceAll('\\', '/') } });
add({ id: 'harmonia-drawing', name: '@harmonia/dsh-agent/drawing', config: { root: ROOT.replaceAll('\\', '/') } });
add({ id: 'harmonia-qq-actions', name: '@harmonia/dsh-agent/qq-actions', config: { root: ROOT.replaceAll('\\', '/') } });
const legacy = old.find(x => x.id === 'harmonia-proactive'); if (legacy) legacy.disabled = true;
// The plugin and both transports share the native SQLite index.
const expression = entries.find(x => x.id === 'dsh-expression');
const memeRoot = path.join(ROOT, 'assets/stickers/shared');
if (expression) { expression.disabled = false; expression.config = { ...expression.config, memeRoot: memeRoot.replaceAll('\\', '/') }; }
else entries.push({ id: 'dsh-expression', disabled: false, config: { memeRoot: memeRoot.replaceAll('\\', '/') } });
const settingsFile = path.join(os.homedir(), '.dsh/dsh-expression.json');
const settings = JSON.parse(await readFile(settingsFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
await writeFile(settingsFile, JSON.stringify({ ...settings, memeRoot, packId: '_custom',
  enabledPacks: [...new Set([...(settings.enabledPacks || []), '_custom'])] }, null, 2) + '\n');
await writeFile(file, YAML.dump(entries, { lineWidth: -1, noRefs: true }), 'utf8');
console.log('Registered Harmonia moderation, alive, drawing and isolated sticker skill; old proactive scheduler disabled.');
