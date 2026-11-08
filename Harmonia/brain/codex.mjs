import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { codexCommand, syncCodexProvider } from '../lib/codex-provider.mjs';
import { proxyEnv } from '../lib/network.mjs';

// Shared engine, isolated capabilities: chat text must never become a filesystem or shell tool call.
export const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apply_patch_freeform', 'view_image', 'apps', 'plugins',
  'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'multi_agent',
  'goals', 'tool_suggest', 'sleep_tool', 'skill_search', 'memories', 'hooks', 'image_generation',
  'code_mode', 'code_mode_host', 'code_mode_host_grpc', 'code_mode_only', 'workspace_dependencies',
];
export function codexArgs(config, output, images = []) {
  const args = ['exec', '--ignore-rules', '--ephemeral', '--json',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', config.root,
    '--output-schema', path.join(config.root, 'brain/response.schema.json'), '--output-last-message', output,
    '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0',
    '-c', 'skills.include_instructions=false', '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}', '-c', `log_dir=${JSON.stringify(path.join(config.cache, 'codex-logs').replaceAll('\\', '/'))}`,
    '-c', 'include_apps_instructions=false',
    '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'tools.update_plan.enabled=false'];
  for (const feature of DISABLED_FEATURES) args.push('-c', `features.${feature}=false`);
  if (config.model) args.push('--model', config.model);
  if (config.env.CODEX_REASONING_EFFORT) args.push('-c', `model_reasoning_effort=${JSON.stringify(config.env.CODEX_REASONING_EFFORT)}`);
  for (const image of images) args.push('--image', image);
  args.push('-');
  return args;
}
export function codexEnv(config) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.CODEX_HOME = path.join(config.root, 'runtime/codex-home');
  env.TEMP = env.TMP = path.join(config.cache, 'tmp');
  if (config.env.API_KEY) env.OPENAI_API_KEY = config.env.API_KEY;
  for (const name of config.provider?.envKeys || []) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ...proxyEnv(config) };
}
export async function runCodex({ prompt, images = [], signal }, config) {
  signal?.throwIfAborted();
  syncCodexProvider(config);
  await mkdir(config.cache, { recursive: true });
  await mkdir(path.join(config.cache, 'tmp'), { recursive: true });
  await mkdir(path.join(config.root, 'runtime/codex-home'), { recursive: true });
  const temporary = await mkdtemp(path.join(config.cache, 'turn-'));
  const output = path.join(temporary, 'response.json');
  try {
    await new Promise((resolve, reject) => {
      const executable = codexCommand(config);
      const child = spawn(executable.command, [...executable.prefix, ...codexArgs(config, output, images)], {
        cwd: config.root, env: codexEnv(config), windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let count = 0, pending = '', unsafe = false, timedOut = false;
      const kill = () => {
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
        else child.kill();
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, config.timeout);
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      child.stdout.on('data', chunk => {
        count += chunk.length;
        if (count > 2 * 1024 * 1024) { unsafe = true; kill(); return; }
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.item?.type && !['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
              unsafe = true; kill();
            }
          } catch { /* Ignore incomplete diagnostics, never forward them to chat. */ }
        }
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', err => { clearTimeout(timer); signal?.removeEventListener('abort', kill); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        if (signal?.aborted) reject(signal.reason);
        else if (timedOut) reject(new Error('Brain timeout'));
        else if (unsafe) reject(new Error('Unexpected tool activity; reply blocked'));
        else if (code !== 0) reject(new Error(`Codex exited ${code}; check custom provider / npm run check`));
        else resolve();
      });
      child.stdin.end(prompt);
    });
    return JSON.parse(await readFile(output, 'utf8'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
