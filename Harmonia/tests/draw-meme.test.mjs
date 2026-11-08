import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { CACHE, ROOT } from '../lib/config.mjs';
import { drawMeme } from '../lib/draw-meme.mjs';

const args = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><circle cx="160" cy="140" r="75" fill="#FFBB66"/><path d="M95 85L90 30L140 70M180 70L230 30L225 85" fill="#FFBB66" stroke="#513D52" stroke-width="5"/><path d="M120 130L140 140M180 140L200 130M140 170Q160 185 180 170" fill="none" stroke="#513D52" stroke-width="7"/></svg>',
  caption: '就这？', meaning: '得意的小猫；调侃；斗图', motion: 'sway', icon: 'none' };

test('DSH drawing uses the installed exporter directly, verifies animation, and persists a sendable sticker', async t => {
  await mkdir(CACHE, { recursive: true }); const root = await mkdtemp(path.join(CACHE, 'drawing-test-'));
  t.after(() => rm(root, { force: true, recursive: true, maxRetries: 3 }));
  await mkdir(path.join(root, 'skills/dsh'), { recursive: true });
  await symlink(path.join(ROOT, 'skills/dsh/pixel-gif-sticker-pack'), path.join(root, 'skills/dsh/pixel-gif-sticker-pack'), 'junction');
  const result = await drawMeme(args, { root, cache: path.join(root, '.cache') });
  const meta = await sharp(result.sticker).metadata();
  assert.equal(meta.pages, 24); assert.equal(meta.loop, 0); assert.equal(result.durationMs, 1920);
  assert.equal(meta.width, 320); assert.equal(meta.height, 320); assert.ok(meta.hasAlpha);
  assert.deepEqual(await readFile(result.sticker), await readFile(result.file));
  await rm(path.join(root, '.cache'), { force: true, recursive: true });
  assert.equal((await sharp(result.sticker).metadata()).pages, 24, 'Clearing cache must not destroy the delivery');
});

test('public drawing accepts art data, never arbitrary scripts, disk reads or remote resources', async () => {
  for (const svg of ['<svg><image href="file:///C:/secret.png"/></svg>', '<svg><image href="https://evil.test/a.png"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///C:/secret.txt">]><svg/>', '<svg><script>bad()</script></svg>', '<svg><rect style="fill:url(https://evil.test)"/></svg>']) {
    await assert.rejects(drawMeme({ ...args, svg }, {}), /self-contained SVG/);
  }
  await assert.rejects(drawMeme({ ...args, motion: 'run-shell' }, {}), /Invalid sticker/);
});
