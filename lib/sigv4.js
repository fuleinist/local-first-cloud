// AWS Signature Version 4 (header-based) — signing and verification.
// Zero dependencies; node:crypto only. S3 flavor: canonical URI is the
// already-URI-encoded path (no normalization, no double-encoding).

import crypto from 'node:crypto';

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const MAX_SKEW_SECONDS = 15 * 60;

export class AuthError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function md5hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

// RFC 3986 percent-encoding, uppercase hex.
export function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

export function amzDateParts(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export function parseAmzDate(amzDate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate || '');
  if (!m) return null;
  const [, Y, M, D, h, mi, s] = m;
  const d = new Date(Date.UTC(+Y, +M - 1, +D, +h, +mi, +s));
  return Number.isNaN(d.getTime()) ? null : d;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// Canonical query string from URLSearchParams or a plain object.
export function canonicalQuery(query) {
  const pairs = [];
  if (query) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
    for (const [k, v] of params) pairs.push([uriEncode(k), uriEncode(v)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export function canonicalRequest({ method, path, query, signedNames, headers, payloadHash }) {
  const canonHeaders = signedNames.map((n) => `${n}:${String(headers[n] ?? '').trim()}\n`).join('');
  // AWS spec: CanonicalHeaders block already ends with \n; SignedHeaders
  // follows immediately (no extra blank line). Query is always normalized.
  return [
    method.toUpperCase(),
    path,
    canonicalQuery(query),
    canonHeaders + signedNames.join(';'),
    payloadHash,
  ].join('\n');
}

// Sign a request. `path` must be the URI-encoded absolute path (S3 style).
// Returns the full lowercase header map to send (includes authorization).
export function signRequest({
  method,
  path,
  query = '',
  headers = {},
  payloadHash,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  now = new Date(),
}) {
  const { amzDate, dateStamp } = amzDateParts(now);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  h['x-amz-date'] = amzDate;
  h['x-amz-content-sha256'] = payloadHash;
  const signedNames = Object.keys(h).sort();
  const canonical = canonicalRequest({ method, path, query, signedNames, headers: h, payloadHash });
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${ALGORITHM}\n${amzDate}\n${scope}\n${sha256hex(canonical)}`;
  const signature = hmac(signingKey(secretAccessKey, dateStamp, region, service), stringToSign).toString('hex');
  h.authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
  return h;
}

// Verify a signed request. Throws AuthError on failure.
// `path` = raw (already encoded) pathname from the URL.
export function verifyRequest({
  method,
  path,
  query = '',
  headers,
  body = Buffer.alloc(0),
  getSecret,
  region,
  now = new Date(),
  maxSkewSeconds = MAX_SKEW_SECONDS,
}) {
  const auth = headers.authorization;
  if (!auth) throw new AuthError('AccessDenied', 403, 'Missing Authorization header');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/\s]+)\/(\d{8})\/([^/\s]+)\/([^/\s]+)\/aws4_request,\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-fA-F]{64})$/.exec(auth.trim());
  if (!m) throw new AuthError('AuthorizationHeaderMalformed', 403, 'Could not parse Authorization header');
  const [, accessKeyId, dateStamp, credRegion, service, signedHeadersStr, signature] = m;

  const amzDate = headers['x-amz-date'];
  const reqTime = parseAmzDate(amzDate);
  if (!reqTime) throw new AuthError('AccessDenied', 403, 'Missing or invalid x-amz-date header');
  const skew = Math.abs(now.getTime() - reqTime.getTime()) / 1000;
  if (skew > maxSkewSeconds) {
    throw new AuthError('RequestTimeTooSkewed', 403, 'The difference between the request time and the current time is too large');
  }
  if (region && credRegion !== region) {
    throw new AuthError('AuthorizationHeaderMalformed', 403, `The authorization header is malformed; the region '${credRegion}' is wrong; expecting '${region}'`);
  }

  const secret = typeof getSecret === 'function' ? getSecret(accessKeyId) : getSecret;
  if (!secret) throw new AuthError('InvalidAccessKeyId', 403, 'The AWS Access Key Id you provided does not exist in our records.');

  // Payload hash check
  const contentSha = headers['x-amz-content-sha256'];
  if (!contentSha) throw new AuthError('InvalidRequest', 400, 'Missing x-amz-content-sha256 header');
  if (contentSha.startsWith('STREAMING-')) {
    throw new AuthError('NotImplemented', 501, 'Chunked upload signatures (STREAMING-*) are not supported; disable chunked encoding or use UNSIGNED-PAYLOAD');
  }
  if (contentSha !== UNSIGNED_PAYLOAD) {
    const actual = sha256hex(body);
    if (actual !== contentSha.toLowerCase()) {
      throw new AuthError('XAmzContentSHA256Mismatch', 400, 'The provided "x-amz-content-sha256" does not match the computed hash of the request payload');
    }
  }

  const signedNames = signedHeadersStr.split(';').filter(Boolean);
  if (!signedNames.includes('host')) throw new AuthError('AccessDenied', 403, 'Signed headers must include host');
  for (const n of signedNames) {
    if (headers[n] === undefined) throw new AuthError('AccessDenied', 403, `Signed header '${n}' is missing from the request`);
  }
  const canonical = canonicalRequest({ method, path, query, signedNames, headers, payloadHash: contentSha });
  const scope = `${dateStamp}/${credRegion}/${service}/aws4_request`;
  const stringToSign = `${ALGORITHM}\n${amzDate}\n${scope}\n${sha256hex(canonical)}`;
  const expected = hmac(signingKey(secret, dateStamp, credRegion, service), stringToSign);
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new AuthError('SignatureDoesNotMatch', 403, 'The request signature we calculated from you does not match the signature you provided.');
  }
  return { accessKeyId, ok: true };
}
