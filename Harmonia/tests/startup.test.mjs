import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { codexArgs, codexEnv } from '../brain/codex.mjs';
import { codexCommand } from '../lib/codex-provider.mjs';
import { patchSource, patchWechatLogin } from '../scripts/patch-wechat-login.mjs';

test('provider selection excludes personal tools and secrets outside inference config', () => {
  const code = `import runpy; m=runpy.run_path('scripts/sync-codex-provider.py'); selected=m['select_config']({'model':'test-model','model_provider':'custom','model_providers':{'custom':{'name':'test','base_url':'https://example.invalid/v1','experimental_bearer_token':'fixture-key'}},'mcp_servers':{'private':{}},'hooks':{'danger':True},'instructions':'private text'}); assert set(selected)=={'model','model_provider','model_providers'}; assert selected['model_providers']['custom']['experimental_bearer_token']=='fixture-key'`;
  const result = spawnSync('python', ['-B', '-c', code], { cwd: loadConfig().root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('Codex retains isolated config and forwards configured proxy without shell interpolation', () => {
  const config = loadConfig();
  config.env = { CODEX_REASONING_EFFORT: 'low', OUTBOUND_PROXY: 'http://127.0.0.1:7897' };
  const args = codexArgs(config, 'output.json');
  assert.equal(args.includes('--ignore-user-config'), false);
  assert.ok(args.includes('model_reasoning_effort="low"'));
  const env = codexEnv(config);
  assert.equal(env.CODEX_HOME, path.join(config.root, 'runtime/codex-home'));
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897/');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.ok(codexCommand(config).command);
});
test('upstream missing helper patch is repeatable and preserves a future real implementation', () => {
  const original = 'workspaceDir, workspacePermission, withLock ${workspacePermission(cfg, chat.key) ?? "默认（跟随 DSH 全局设置）"}';
  const result = patchSource(original, '');
  assert.ok(!result.includes('workspacePermission'));
  assert.equal(patchSource(result, ''), result);
  assert.equal(patchSource(original, 'export function workspacePermission() {}'), original);
});
test('real upstream login CLI imports successfully before network access', async () => {
  const config = loadConfig();
  await patchWechatLogin(config.root);
  const result = spawnSync(process.execPath, [path.join(config.root, 'vendor/wechat-bridge/weixin-bot.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /login/);
});
