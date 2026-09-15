import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uriEncode, signRequest, verifyRequest, sha256hex, amzDateParts, parseAmzDate,
  canonicalQuery, EMPTY_SHA256, UNSIGNED_PAYLOAD, AuthError,
} from '../lib/sigv4.js';

const CREDS = { accessKeyId: 'LFCTESTKEY1234567', secretAccessKey: 'test-secret-key-0123456789abcdef', region: 'us-east-1' };

function signedHeaders(overrides = {}) {
  return signRequest({
    method: 'GET',
    path: '/bucket/key%20one.txt',
    query: new URLSearchParams({ 'list-type': '2', prefix: 'a b' }),
    headers: { host: '127.0.0.1:9100' },
    payloadHash: EMPTY_SHA256,
    now: new Date('2026-09-15T12:00:00Z'),
    ...CREDS,
    ...overrides,
  });
}

test('uriEncode follows RFC3986', () => {
  assert.equal(uriEncode('a b'), 'a%20b');
  assert.equal(uriEncode('a/b', false), 'a/b');
  assert.equal(uriEncode('a/b', true), 'a%2Fb');
  assert.equal(uriEncode('~.-_plain123'), '~.-_plain123');
  assert.equal(uriEncode('é'), '%C3%A9');
  assert.equal(uriEncode('plus+eq=amp&'), 'plus%2Beq%3Damp%26');
});

test('canonicalQuery sorts and encodes', () => {
  assert.equal(canonicalQuery(new URLSearchParams({ b: '2', a: '1 2' })), 'a=1%202&b=2');
  assert.equal(canonicalQuery({ 'x-y': '' }), 'x-y=');
});

test('amzDate round-trips', () => {
  const { amzDate } = amzDateParts(new Date('2026-09-15T12:00:00Z'));
  assert.equal(amzDate, '20260915T120000Z');
  assert.equal(parseAmzDate(amzDate).getTime(), Date.parse('2026-09-15T12:00:00Z'));
  assert.equal(parseAmzDate('garbage'), null);
});

test('sign/verify round-trip succeeds', () => {
  const h = signedHeaders();
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=LFCTESTKEY1234567\/20260915\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  const res = verifyRequest({
    method: 'GET',
    path: '/bucket/key%20one.txt',
    query: '?list-type=2&prefix=a+b',
    headers: h,
    body: Buffer.alloc(0),
    getSecret: (id) => (id === CREDS.accessKeyId ? CREDS.secretAccessKey : null),
    region: 'us-east-1',
    now: new Date('2026-09-15T12:00:05Z'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.accessKeyId, CREDS.accessKeyId);
});

test('PUT with body verifies payload hash', () => {
  const body = Buffer.from('hello cloud');
  const h = signRequest({
    method: 'PUT',
    path: '/b/k.txt',
    headers: { host: 'localhost:9100' },
    payloadHash: sha256hex(body),
    now: new Date('2026-09-15T12:00:00Z'),
    ...CREDS,
  });
  const ok = verifyRequest({
    method: 'PUT', path: '/b/k.txt', headers: h, body,
    getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:00:01Z'),
  });
  assert.equal(ok.ok, true);
  // tampered body fails
  assert.throws(
    () => verifyRequest({ method: 'PUT', path: '/b/k.txt', headers: h, body: Buffer.from('hello CLOUD'), getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:00:01Z') }),
    (e) => e instanceof AuthError && e.code === 'XAmzContentSHA256Mismatch'
  );
  // unsigned payload skips body check
  const h2 = signRequest({
    method: 'PUT', path: '/b/k.txt', headers: { host: 'localhost:9100' },
    payloadHash: UNSIGNED_PAYLOAD, now: new Date('2026-09-15T12:00:00Z'), ...CREDS,
  });
  assert.equal(verifyRequest({ method: 'PUT', path: '/b/k.txt', headers: h2, body: Buffer.from('anything'), getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:00:01Z') }).ok, true);
});

test('tampered signature fails', () => {
  const h = signedHeaders();
  h.authorization = h.authorization.replace(/Signature=[0-9a-f]{64}/, 'Signature=' + '0'.repeat(64));
  assert.throws(
    () => verifyRequest({ method: 'GET', path: '/bucket/key%20one.txt', query: '?list-type=2&prefix=a+b', headers: h, getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:00:05Z') }),
    (e) => e.code === 'SignatureDoesNotMatch'
  );
});

test('wrong secret fails', () => {
  const h = signedHeaders();
  assert.throws(
    () => verifyRequest({ method: 'GET', path: '/bucket/key%20one.txt', query: '?list-type=2&prefix=a+b', headers: h, getSecret: 'wrong-secret', now: new Date('2026-09-15T12:00:05Z') }),
    (e) => e.code === 'SignatureDoesNotMatch'
  );
});

test('unknown access key fails', () => {
  const h = signedHeaders();
  assert.throws(
    () => verifyRequest({ method: 'GET', path: '/bucket/key%20one.txt', query: '?list-type=2&prefix=a+b', headers: h, getSecret: () => null, now: new Date('2026-09-15T12:00:05Z') }),
    (e) => e.code === 'InvalidAccessKeyId'
  );
});

test('clock skew beyond 15 min fails', () => {
  const h = signedHeaders();
  assert.throws(
    () => verifyRequest({ method: 'GET', path: '/bucket/key%20one.txt', query: '?list-type=2&prefix=a+b', headers: h, getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:20:00Z') }),
    (e) => e.code === 'RequestTimeTooSkewed'
  );
});

test('missing authorization header fails', () => {
  assert.throws(
    () => verifyRequest({ method: 'GET', path: '/', headers: {}, getSecret: CREDS.secretAccessKey }),
    (e) => e.code === 'AccessDenied'
  );
});

test('wrong region fails when region enforced', () => {
  const h = signedHeaders();
  assert.throws(
    () => verifyRequest({ method: 'GET', path: '/bucket/key%20one.txt', query: '?list-type=2&prefix=a+b', headers: h, getSecret: CREDS.secretAccessKey, region: 'eu-west-1', now: new Date('2026-09-15T12:00:05Z') }),
    (e) => e.code === 'AuthorizationHeaderMalformed'
  );
});

test('streaming payload signatures rejected', () => {
  const h = signRequest({
    method: 'PUT', path: '/b/k', headers: { host: 'h' },
    payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', now: new Date('2026-09-15T12:00:00Z'), ...CREDS,
  });
  assert.throws(
    () => verifyRequest({ method: 'PUT', path: '/b/k', headers: h, body: Buffer.alloc(0), getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:00:01Z') }),
    (e) => e.code === 'NotImplemented' && e.status === 501
  );
});

test('tampered method fails', () => {
  const h = signedHeaders();
  assert.throws(
    () => verifyRequest({ method: 'DELETE', path: '/bucket/key%20one.txt', query: '?list-type=2&prefix=a+b', headers: h, getSecret: CREDS.secretAccessKey, now: new Date('2026-09-15T12:00:05Z') }),
    (e) => e.code === 'SignatureDoesNotMatch'
  );
});
