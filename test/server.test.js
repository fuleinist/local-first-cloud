import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createServer } from '../lib/server.js';
import * as client from '../lib/client.js';
import { genKeys } from '../lib/config.js';
import { sha256hex } from '../lib/sigv4.js';

let tmp;
let server;
let cfg;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

function close(s) {
  return new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections?.();
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-server-'));
  const keys = genKeys();
  cfg = {
    dataDir: path.join(tmp, 'data'),
    region: 'us-east-1',
    ...keys,
  };
  server = createServer(cfg);
  const port = await listen(server);
  cfg.endpoint = `http://127.0.0.1:${port}`;
});

after(async () => {
  await close(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health endpoint is unauthenticated JSON', async () => {
  const h = await client.health(cfg);
  assert.equal(h.ok, true);
  assert.equal(h.service, 'local-first-cloud');
  assert.equal(h.auth, 'sigv4');
});

test('unsigned request rejected 403 when auth configured', async () => {
  await assert.rejects(
    () => client.s3Request({ ...cfg, accessKeyId: undefined, secretAccessKey: undefined }, { method: 'GET' }),
    (e) => e.status === 403 && e.code === 'AccessDenied'
  );
});

test('wrong secret rejected 403 SignatureDoesNotMatch', async () => {
  await assert.rejects(
    () => client.s3Request({ ...cfg, secretAccessKey: 'nope-nope-nope' }, { method: 'GET' }),
    (e) => e.status === 403 && e.code === 'SignatureDoesNotMatch'
  );
});

test('wrong access key rejected 403 InvalidAccessKeyId', async () => {
  await assert.rejects(
    () => client.s3Request({ ...cfg, accessKeyId: 'LFCBOGUSBOGUSBOG' }, { method: 'GET' }),
    (e) => e.status === 403 && e.code === 'InvalidAccessKeyId'
  );
});

test('full signed object lifecycle: mb put ls get copy head rm rb', async () => {
  await client.createBucket(cfg, 'test-bucket');
  const body = Buffer.from('the quick brown fox jumps over the lazy dog');
  const { etag } = await client.putObject(cfg, 'test-bucket', 'docs/fox.txt', body, {
    contentType: 'text/plain',
    userMeta: { author: 'lfc-test' },
  });
  assert.equal(etag, crypto.createHash('md5').update(body).digest('hex'));

  const buckets = await client.listBuckets(cfg);
  assert.ok(buckets.some((b) => b.name === 'test-bucket'));

  const listing = await client.listObjects(cfg, 'test-bucket', { prefix: 'docs/' });
  assert.deepEqual(listing.objects.map((o) => o.key), ['docs/fox.txt']);
  assert.equal(listing.objects[0].size, body.length);

  const got = await client.getObjectBuffer(cfg, 'test-bucket', 'docs/fox.txt');
  assert.deepEqual(got.body, body);
  assert.equal(got.headers.get('content-type'), 'text/plain');

  const head = await client.headObject(cfg, 'test-bucket', 'docs/fox.txt');
  assert.equal(head.size, body.length);
  assert.deepEqual(head.userMeta, { author: 'lfc-test' });

  // copy via header
  await client.s3Request(cfg, {
    method: 'PUT',
    bucket: 'test-bucket',
    key: 'docs/fox-copy.txt',
    headers: { 'x-amz-copy-source': '/test-bucket/docs/fox.txt' },
  });
  const copied = await client.getObjectBuffer(cfg, 'test-bucket', 'docs/fox-copy.txt');
  assert.deepEqual(copied.body, body);

  await client.deleteObject(cfg, 'test-bucket', 'docs/fox.txt');
  await client.deleteObject(cfg, 'test-bucket', 'docs/fox-copy.txt');
  await assert.rejects(() => client.getObjectBuffer(cfg, 'test-bucket', 'docs/fox.txt'), (e) => e.status === 404 && e.code === 'NoSuchKey');

  // head 404
  await assert.rejects(() => client.headObject(cfg, 'test-bucket', 'docs/fox.txt'), (e) => e.status === 404);

  await client.deleteBucket(cfg, 'test-bucket');
  const after = await client.listBuckets(cfg);
  assert.ok(!after.some((b) => b.name === 'test-bucket'));
});

test('keys with spaces and unicode survive signed round-trip', async () => {
  await client.createBucket(cfg, 'uni-bucket');
  const key = 'weird dir/ünïcode 文件+&=.txt';
  const body = Buffer.from('unicode key content');
  await client.putObject(cfg, 'uni-bucket', key, body);
  const got = await client.getObjectBuffer(cfg, 'uni-bucket', key);
  assert.deepEqual(got.body, body);
  const listing = await client.listObjects(cfg, 'uni-bucket', { prefix: 'weird dir/' });
  assert.deepEqual(listing.objects.map((o) => o.key), [key]);
  await client.deleteBucket(cfg, 'uni-bucket', { force: true });
});

test('bucket not empty -> 409 BucketNotEmpty', async () => {
  await client.createBucket(cfg, 'nonempty');
  await client.putObject(cfg, 'nonempty', 'keep.txt', Buffer.from('k'));
  await assert.rejects(() => client.deleteBucket(cfg, 'nonempty'), (e) => e.status === 409 && e.code === 'BucketNotEmpty');
  await client.deleteBucket(cfg, 'nonempty', { force: true });
});

test('no such bucket -> 404 NoSuchBucket', async () => {
  await assert.rejects(() => client.listObjects(cfg, 'ghost-bucket', {}), (e) => e.status === 404 && e.code === 'NoSuchBucket');
});

test('invalid bucket name -> 400', async () => {
  await assert.rejects(() => client.createBucket(cfg, 'UPPER'), (e) => e.status === 400);
});

test('path traversal in URL is rejected and touches nothing', async () => {
  await client.createBucket(cfg, 'trav');
  const base = cfg.endpoint;
  const host = new URL(base).host;
  const { signRequest } = await import('../lib/sigv4.js');

  // Raw signed requests with pre-encoded traversal paths — these reach the
  // server verbatim; decodeKeyFromPath decodes once and validateKey rejects.
  const rawPut = async (rawPath) => {
    const body = Buffer.from('x');
    const h = signRequest({
      method: 'PUT',
      path: rawPath,
      headers: { host },
      payloadHash: sha256hex(body),
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
    });
    return fetch(base + rawPath, { method: 'PUT', headers: { ...h, connection: 'close' }, body });
  };
  for (const p of ['/trav/..%2Fescape.txt', '/trav/%2e%2e%2fescape.txt', '/trav/a%5Cb.txt']) {
    const res = await rawPut(p);
    assert.equal(res.status, 400, `expected 400 for raw path ${p}`);
    const xml = await res.text();
    assert.ok(xml.includes('<Code>InvalidArgument</Code>'), `expected InvalidArgument for ${p}: ${xml}`);
  }

  // Via the normal client: literal traversal gets rejected (400) or
  // neutralized by URL normalization -> signature 403. Double-encoded
  // variants become harmless LITERAL keys inside the bucket (same as real
  // S3) - safe, but verify they stay contained.
  for (const bad of ['../escape.txt', 'a/../../escape.txt', 'a\\b.txt']) {
    await assert.rejects(
      () => client.s3Request(cfg, { method: 'PUT', bucket: 'trav', key: bad, body: Buffer.from('x') }),
      (e) => e.status === 400 || e.status === 403,
      `expected 400/403 for ${bad}`
    );
  }
  for (const literal of ['..%2Fescape.txt', '%2e%2e%2fescape.txt']) {
    await client.s3Request(cfg, { method: 'PUT', bucket: 'trav', key: literal, body: Buffer.from('x') });
    const listing = await client.listObjects(cfg, 'trav', { prefix: literal });
    assert.deepEqual(listing.objects.map((o) => o.key), [literal]);
    // stored as a literal filename inside the bucket dir
    assert.ok(fs.existsSync(path.join(tmp, 'data', 'buckets', 'trav', literal)));
  }

  // nothing written outside the bucket dir
  for (const escaped of [path.join(tmp, 'escape.txt'), path.join(tmp, 'data', 'escape.txt'), path.join(tmp, 'data', 'buckets', 'escape.txt'), path.join(tmp, 'data', 'buckets', 'trav', 'a', 'b.txt')]) {
    assert.equal(fs.existsSync(escaped), false, `escaped file exists: ${escaped}`);
  }
  await client.deleteBucket(cfg, 'trav', { force: true });
});

test('DeleteObjects batch delete', async () => {
  await client.createBucket(cfg, 'batch');
  for (const k of ['a', 'b', 'c']) await client.putObject(cfg, 'batch', k, Buffer.from(k));
  const body = '<?xml version="1.0" encoding="UTF-8"?><Delete><Object><Key>a</Key></Object><Object><Key>b</Key></Object><Object><Key>missing</Key></Object></Delete>';
  const res = await client.s3Request(cfg, { method: 'POST', bucket: 'batch', query: { delete: '' }, body: Buffer.from(body), headers: { 'content-type': 'application/xml' } });
  const xml = res.body.toString();
  assert.ok(xml.includes('<Deleted><Key>a</Key></Deleted>'));
  assert.ok(xml.includes('<Deleted><Key>missing</Key></Deleted>'));
  const left = await client.listObjects(cfg, 'batch', {});
  assert.deepEqual(left.objects.map((o) => o.key), ['c']);
  await client.deleteBucket(cfg, 'batch', { force: true });
});

test('ListObjectsV2 paging with continuation tokens', async () => {
  await client.createBucket(cfg, 'paged');
  for (let i = 0; i < 7; i++) await client.putObject(cfg, 'paged', `k${i}.txt`, Buffer.from(String(i)));
  // manual single-page request with max-keys=3
  const page1 = await client.s3Request(cfg, { method: 'GET', bucket: 'paged', query: { 'list-type': '2', 'max-keys': '3' } });
  const xml1 = page1.body.toString();
  assert.ok(xml1.includes('<IsTruncated>true</IsTruncated>'));
  const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml1)[1];
  const page2 = await client.s3Request(cfg, { method: 'GET', bucket: 'paged', query: { 'list-type': '2', 'max-keys': '3', 'continuation-token': token } });
  const xml2 = page2.body.toString();
  const keys2 = [...xml2.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  assert.deepEqual(keys2, ['k3.txt', 'k4.txt', 'k5.txt']);
  // client.listObjects auto-pages
  const all = await client.listObjects(cfg, 'paged', { maxKeys: 2 });
  assert.equal(all.objects.length, 7);
  await client.deleteBucket(cfg, 'paged', { force: true });
});

test('delimiter listing returns CommonPrefixes', async () => {
  await client.createBucket(cfg, 'dirs');
  for (const k of ['top.txt', 'sub/a.txt', 'sub/b.txt', 'sub/deep/c.txt']) {
    await client.putObject(cfg, 'dirs', k, Buffer.from(k));
  }
  const res = await client.listObjects(cfg, 'dirs', { delimiter: '/' });
  assert.deepEqual(res.objects.map((o) => o.key), ['top.txt']);
  assert.deepEqual(res.prefixes, ['sub/']);
  await client.deleteBucket(cfg, 'dirs', { force: true });
});

test('GetBucketAcl returns canned XML', async () => {
  await client.createBucket(cfg, 'aclb');
  const res = await client.s3Request(cfg, { method: 'GET', bucket: 'aclb', query: { acl: '' } });
  const xml = res.body.toString();
  assert.ok(xml.includes('<AccessControlPolicy'));
  assert.ok(xml.includes('<Permission>FULL_CONTROL</Permission>'));
  await client.deleteBucket(cfg, 'aclb');
});

test('multipart upload returns 501 NotImplemented', async () => {
  await client.createBucket(cfg, 'mpu');
  await assert.rejects(
    () => client.s3Request(cfg, { method: 'POST', bucket: 'mpu', key: 'big.bin', query: { uploads: '' } }),
    (e) => e.status === 501 && e.code === 'NotImplemented'
  );
  await client.deleteBucket(cfg, 'mpu');
});

test('anonymous server allows unsigned requests', async () => {
  const anon = createServer({ dataDir: path.join(tmp, 'anon-data'), region: 'us-east-1' });
  const port = await listen(anon);
  try {
    const anonCfg = { endpoint: `http://127.0.0.1:${port}` };
    const h = await client.health(anonCfg);
    assert.equal(h.auth, 'anonymous');
    await client.createBucket(anonCfg, 'anon-bucket');
    await client.putObject(anonCfg, 'anon-bucket', 'f.txt', Buffer.from('anon'));
    const got = await client.getObjectBuffer(anonCfg, 'anon-bucket', 'f.txt');
    assert.equal(got.body.toString(), 'anon');
  } finally {
    await close(anon);
  }
});

test('skewed x-amz-date rejected', async () => {
  // sign manually with an old date using lib internals
  const { signRequest } = await import('../lib/sigv4.js');
  const headers = signRequest({
    method: 'GET',
    path: '/',
    query: '',
    headers: { host: new URL(cfg.endpoint).host },
    payloadHash: sha256hex(Buffer.alloc(0)),
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: 'us-east-1',
    now: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
  });
  const res = await fetch(cfg.endpoint + '/', { headers: { ...headers, connection: 'close' } });
  assert.equal(res.status, 403);
  const xml = await res.text();
  assert.ok(xml.includes('<Code>RequestTimeTooSkewed</Code>'));
});
