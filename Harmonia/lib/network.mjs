import { setGlobalProxyFromEnv } from 'node:http';
import { createConnection } from 'node:net';

export function proxyEnv(config) {
  if (!config.env.OUTBOUND_PROXY) return {};
  const url = new URL(config.env.OUTBOUND_PROXY);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OUTBOUND_PROXY must be HTTP(S)');
  return { HTTPS_PROXY: url.href, HTTP_PROXY: url.href, NO_PROXY: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1' };
}
export async function configureNetwork(config) {
  const env = proxyEnv(config);
  if (!env.HTTPS_PROXY) return;
  const url = new URL(env.HTTPS_PROXY);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    const available = await new Promise(resolve => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port || 80) });
      const done = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
    });
    if (!available) { setGlobalProxyFromEnv({ HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' }); return; }
  }
  setGlobalProxyFromEnv(env);
}
