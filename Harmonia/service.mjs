import { loadConfig } from './lib/config.mjs';
import { createRouter } from './brain/unified-router.mjs';
import { createQQ } from './adapters/qq.mjs';
import { runWechat, sendWechatOwner } from './adapters/wechat.mjs';
import { createDelivery } from './lib/delivery.mjs';
import { dshStatus } from './brain/dsh.mjs';
import { ownerAccess, writeJson } from './lib/store.mjs';
import { drainProactive } from './lib/proactive-delivery.mjs';
import path from 'node:path';

const config = loadConfig();
const status = { brain: config.brain, brainReady: config.brain !== 'dsh', wechat: 'disabled', completed: 0, failed: 0 };
const refreshBrain = async () => {
  if (config.brain !== 'dsh') return;
  try { status.brainReady = (await dshStatus(config)).ready; }
  catch { status.brainReady = false; }
};
await refreshBrain();
const brainCheck = setInterval(refreshBrain, 30000); brainCheck.unref();
const abort = new AbortController();
let qq;
const router = createRouter(config, { sendGroup: (id, text) => {
  if (!qq) throw new Error('QQ channel disabled');
  return qq.sendGroup(id, text);
} });
const deliver = createDelivery(config, (message, options) => {
  if (!status.brainReady) return { bubbles: ['模型还没配置好，请先打开 DSH 控制台设置模型提供商和默认模型。'] };
  return router(message, options);
}, status);
if (config.qqEnabled) {
  qq = createQQ(config, receive, () => status);
  await qq.start();
  console.log(`[Harmonia] OneBot reverse WS: ws://127.0.0.1:${config.port}/ws`);
}
if (config.wechatEnabled) {
  runWechat(config, receive, status, abort.signal).catch(() => {
    status.wechat = 'login-required';
    console.error('[WeChat] unavailable: run start-wechat-login.bat, then restart this service. QQ remains available.');
  });
}
async function receive(message, transport) {
  if (ownerAccess(message, config)) {
    await writeJson(path.join(config.root, 'runtime/owner-activity.json'), { at: Date.now(), channel: message.channel });
  }
  return deliver(message, transport);
}
let proactiveBusy = false;
const proactiveCheck = setInterval(async () => {
  if (proactiveBusy || !status.brainReady) return;
  proactiveBusy = true;
  try {
    status.proactive = await drainProactive(config, {
      qq: qq ? response => qq.sendOwner(response) : undefined,
      wechat: status.wechat === 'polling' ? response => sendWechatOwner(config, response) : undefined,
    });
  } catch { status.proactive = { sent: false, reason: 'local-error' }; }
  finally { proactiveBusy = false; }
}, 30000); proactiveCheck.unref();
console.log('[Harmonia] persona: config/PERSONA.md (read on every turn)');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { abort.abort(); qq?.close(); });
