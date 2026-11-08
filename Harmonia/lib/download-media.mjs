import http from 'node:http';
import https from 'node:https';
import { validateFetchUrl } from '../vendor/qq-bridge/src/safe-fetch.js';
import { MAX_DOWNLOAD_BYTES } from './media.mjs';

// Reuse upstream DNS/SSRF validation, pin the connection and check every redirect; never give FFmpeg a remote URL.
export async function downloadMedia(url, limit = MAX_DOWNLOAD_BYTES, redirects = 0) {
  if (redirects > 4) throw new Error('Too many media redirects');
  const safe = await validateFetchUrl(url);
  const address = safe.addresses.find(a => a.family === 4) || safe.addresses[0];
  return new Promise((resolve, reject) => {
    const request = (safe.url.protocol === 'https:' ? https : http).get(safe.url, {
      lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: { 'User-Agent': 'Harmonia/1.0' },
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) { response.destroy(); resolve(downloadMedia(new URL(response.headers.location, safe.url).href, limit, redirects + 1)); return; }
      if (response.statusCode < 200 || response.statusCode >= 300 || Number(response.headers['content-length']) > limit) { response.destroy(); reject(new Error('Media response rejected')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > limit) { response.destroy(new Error('Media exceeds download limit')); } else chunks.push(chunk); });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks) })); response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('Media download timeout')), 20000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject);
  });
}
