import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store, S3Error, validateBucket, validateKey } from '../lib/store.js';

let tmp;
let store;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-store-'));
  store = new Store(path.join(tmp, 'data'));
  await store.init();
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bucket name validation', () => {
  for (const ok of ['abc', 'my-bucket', 'my.bucket', 'a1b', 'x'.repeat(63)]) validateBucket(ok);
  for (const bad of ['AB', 'ab', '-ab', 'ab-', 'a..b', 'a b', 'a_b', 'ab/', '', 'x'.repeat(64), 'a\\b']) {
    assert.throws(() => validateBucket(bad), S3Error, `should reject: ${bad}`);
  }
});

test('key validation blocks traversal and absolute paths', () => {
  for (const ok of ['a.txt', 'dir/a b.txt', 'a+b/c~d', 'ünïcode/文件.txt', 'a'.repeat(1024)]) validateKey(ok);
  for (const bad of ['', '/abs.txt', '..\\x', '../x', 'a/../b', 'a//b', './a', 'a/./b', 'a\\b', 'a'.repeat(1025)]) {
    assert.throws(() => validateKey(bad), S3Error, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('objectPath cannot escape bucket dir', () => {
  // even if validation were bypassed, resolved path is checked
  assert.throws(() => store.objectPath('bucket', '../other/x'), S3Error);
});

test('bucket lifecycle', async () => {
  await store.createBucket('photos');
  await assert.rejects(() => store.createBucket('photos'), (e) => e.code === 'BucketAlreadyOwnedByYou' && e.status === 409);
  await store.headBucket('photos');
  await assert.rejects(() => store.headBucket('nope'), (e) => e.code === 'NoSuchBucket');
  const buckets = await store.listBuckets();
  assert.deepEqual(buckets.map((b) => b.name), ['photos']);
});

test('put/get/head/delete object round-trip', async () => {
  const body = Buffer.from('hello local cloud');
  const meta = await store.putObject('photos', 'dir/one.txt', body, { contentType: 'text/plain', userMeta: { src: 'test' } });
  assert.equal(meta.size, body.length);
  assert.match(meta.etag, /^[0-9a-f]{32}$/);

  const got = await store.getObjectBuffer('photos', 'dir/one.txt');
  assert.deepEqual(got, body);

  const m = await store.getMeta('photos', 'dir/one.txt');
  assert.equal(m.contentType, 'text/plain');
  assert.deepEqual(m.userMeta, { src: 'test' });

  const f = await store.getObjectFile('photos', 'dir/one.txt');
  assert.equal(f.stat.size, body.length);
  // raw file on disk is untouched plaintext
  assert.equal(fs.readFileSync(f.path, 'utf8'), 'hello local cloud');

  await store.deleteObject('photos', 'dir/one.txt');
  await assert.rejects(() => store.getObjectBuffer('photos', 'dir/one.txt'), (e) => e.code === 'NoSuchKey');
  // delete is idempotent
  await store.deleteObject('photos', 'dir/one.txt');
});

test('copy object preserves content and metadata', async () => {
  await store.putObject('photos', 'src.txt', Buffer.from('copy me'), { contentType: 'text/plain', userMeta: { a: '1' } });
  await store.copyObject('photos', 'src.txt', 'photos', 'nested/dst.txt');
  assert.deepEqual(await store.getObjectBuffer('photos', 'nested/dst.txt'), Buffer.from('copy me'));
  const m = await store.getMeta('photos', 'nested/dst.txt');
  assert.deepEqual(m.userMeta, { a: '1' });
  await store.deleteObject('photos', 'src.txt');
  await store.deleteObject('photos', 'nested/dst.txt');
});

test('deleteBucket refuses non-empty, force empties', async () => {
  await store.createBucket('temp');
  await store.putObject('temp', 'a.txt', Buffer.from('x'));
  await assert.rejects(() => store.deleteBucket('temp'), (e) => e.code === 'BucketNotEmpty' && e.status === 409);
  await store.deleteBucket('temp', { force: true });
  await assert.rejects(() => store.headBucket('temp'), (e) => e.code === 'NoSuchBucket');
  await assert.rejects(() => store.deleteBucket('temp'), (e) => e.code === 'NoSuchBucket');
});

test('list with prefix, delimiter, paging', async () => {
  await store.createBucket('listing');
  const keys = ['a.txt', 'docs/one.md', 'docs/two.md', 'docs/sub/deep.md', 'z.txt'];
  for (const k of keys) await store.putObject('listing', k, Buffer.from(k));

  const all = await store.list('listing', {});
  assert.deepEqual(all.contents.map((o) => o.key), [...keys].sort());
  assert.equal(all.isTruncated, false);

  const docs = await store.list('listing', { prefix: 'docs/' });
  assert.deepEqual(docs.contents.map((o) => o.key), ['docs/one.md', 'docs/sub/deep.md', 'docs/two.md']);

  const delim = await store.list('listing', { delimiter: '/' });
  assert.deepEqual(delim.contents.map((o) => o.key), ['a.txt', 'z.txt']);
  assert.deepEqual(delim.commonPrefixes, ['docs/']);

  const delim2 = await store.list('listing', { prefix: 'docs/', delimiter: '/' });
  assert.deepEqual(delim2.contents.map((o) => o.key), ['docs/one.md', 'docs/two.md']);
  assert.deepEqual(delim2.commonPrefixes, ['docs/sub/']);

  const page1 = await store.list('listing', { maxKeys: 2 });
  assert.equal(page1.contents.length, 2);
  assert.equal(page1.isTruncated, true);
  assert.ok(page1.nextContinuationToken);
  const tokenKey = Buffer.from(page1.nextContinuationToken, 'base64url').toString('utf8');
  const page2 = await store.list('listing', { maxKeys: 2, startAfter: tokenKey });
  assert.deepEqual(page2.contents.map((o) => o.key), ['docs/sub/deep.md', 'docs/two.md']);

  const sizes = await store.list('listing', { prefix: 'a.txt' });
  assert.equal(sizes.contents[0].size, Buffer.byteLength('a.txt'));
  assert.match(sizes.contents[0].etag, /^[0-9a-f]{32}$/);

  await assert.rejects(() => store.list('missing-bucket', {}), (e) => e.code === 'NoSuchBucket');
});

test('deleteObjects batch', async () => {
  await store.putObject('listing', 'x1', Buffer.from('1'));
  await store.putObject('listing', 'x2', Buffer.from('2'));
  const deleted = await store.deleteObjects('listing', ['x1', 'x2', 'nonexistent']);
  assert.deepEqual(deleted, ['x1', 'x2', 'nonexistent']);
  await assert.rejects(() => store.getObjectBuffer('listing', 'x1'), (e) => e.code === 'NoSuchKey');
});
