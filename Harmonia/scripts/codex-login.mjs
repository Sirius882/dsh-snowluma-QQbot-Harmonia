import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { codexEnv } from '../brain/codex.mjs';
import { codexCommand, syncCodexProvider } from '../lib/codex-provider.mjs';

const config = loadConfig();
const provider = syncCodexProvider(config);
if (provider.custom) { console.log(`Using configured custom provider ${provider.provider}; OpenAI login is not required.`); process.exit(0); }
await mkdir(path.join(config.root, 'runtime/codex-home'), { recursive: true });
await mkdir(path.join(config.cache, 'tmp'), { recursive: true });
const args = config.env.API_KEY ? ['login', '--with-api-key'] : ['login', '--device-auth'];
const executable = codexCommand(config);
const child = spawn(executable.command, [...executable.prefix, ...args], { env: codexEnv(config), stdio: config.env.API_KEY ? ['pipe', 'inherit', 'inherit'] : 'inherit', windowsHide: true });
if (config.env.API_KEY) child.stdin.end(config.env.API_KEY);
child.on('error', () => { console.error('Codex could not start. Check CODEX_BIN.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
