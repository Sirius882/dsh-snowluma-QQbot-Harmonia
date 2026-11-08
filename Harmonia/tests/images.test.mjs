import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from '../lib/config.mjs';
import { MAX_IMAGE_BYTES } from '../lib/images.mjs';
import { MAX_DOWNLOAD_BYTES } from '../lib/media.mjs';
import { prepareQQImages } from '../adapters/qq.mjs';

async function setup(t) {
  await mkdir(CACHE, { recursive: true });
  const cache = await mkdtemp(path.join(CACHE, 'image-test-'));
  t.after(() => rm(cache, { force: true, recursive: true }));
  return { cache };
}
test('QQ accepts the reported 11.93 MiB screenshot within DSH intake budget', async t => {
  const config = await setup(t);
  const buffer = Buffer.alloc(12509275); buffer.set([0x89, 0x50, 0x4e, 0x47]);
  const message = { text: 'test', imageUrls: ['https://example.com/image'] };
  await prepareQQImages(message, config, async (_url, limit) => {
    assert.equal(limit, MAX_DOWNLOAD_BYTES); assert.ok(buffer.length <= limit);
    return { buffer };
  });
  assert.equal(message.images.length, 1);
  assert.equal((await readFile(message.images[0])).length, buffer.length);
  assert.equal(message.text, 'test'); assert.equal(message.imageUrls, undefined);
});
test('failed attachment preserves text and good attachments without pretending to see missing image', async t => {
  const config = await setup(t);
  const message = { text: 'my message', imageUrls: ['bad', 'good'] };
  await prepareQQImages(message, config, async url => {
    if (url === 'bad') throw new Error('oversized or network failure');
    return { buffer: Buffer.from([0xff, 0xd8, 0xff]) };
  });
  assert.equal(message.images.length, 1); assert.match(message.text, /^my message/);
  assert.match(message.text, /1 张图片未能加载/);
});
