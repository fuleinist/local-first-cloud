// Minimal S3 client used by the `lfc` CLI. Signs with SigV4, talks fetch.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { signRequest, sha256hex, uriEncode, EMPTY_SHA256, UNSIGNED_PAYLOAD } from './sigv4.js';
import { S3Error } from './store.js';
import { extractAll, extractOne, unesc } from './xml.js';
import { isAuthConfigured } from './config.js';

export function parseS3Url(spec) {
  const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(spec);
  if (!m) throw new S3Error('InvalidArgument', 400, `Not an s3:// URL: ${spec}`);
  return { bucket: m[1], key: m[2] || '' };
}

function encodedPath(bucket, key) {
  const segs = [];
  if (bucket) segs.push(uriEncode(bucket));
  if (key) for (const s of key.split('/')) segs.push(uriEncode(s));
  return '/' + segs.join('/');
}

export async function s3Request(cfg, { method = 'GET', bucket = '', key = '', query = {}, body, headers = {} }) {
  const endpoint = cfg.endpoint || `http://${cfg.host}:${cfg.port}`;
  const u = new URL(endpoint);
  const p = encodedPath(bucket, key);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  const fullUrl = `${u.origin}${p}${qs ? '?' + qs : ''}`;

  const sendHeaders = { connection: 'close', ...headers };
  let payloadHash = EMPTY_SHA256;
  if (body !== undefined && body !== null) {
    payloadHash = sha256hex(body);
  }

  if (isAuthConfigured(cfg)) {
    const signHeaders = { host: u.host };
    for (const [k, v] of Object.entries(sendHeaders)) {
      if (k.toLowerCase().startsWith('x-amz-')) signHeaders[k.toLowerCase()] = v;
    }
    const signed = signRequest({
      method,
      path: p,
      query: params,
      headers: signHeaders,
      payloadHash,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region || 'us-east-1',
    });
    for (const [k, v] of Object.entries(signed)) {
      if (k === 'host') continue; // fetch sets Host itself
      sendHeaders[k] = v;
    }
  }

  const res = await fetch(fullUrl, { method, headers: sendHeaders, body: body ?? undefined });
  const resBody = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const text = resBody.toString('utf8');
    const code = extractOne(text, 'Code') || `HTTP${res.status}`;
    const message = extractOne(text, 'Message') || res.statusText;
    throw new S3Error(code, res.status, message);
  }
  return { status: res.status, headers: res.headers, body: resBody };
}

export async function health(cfg) {
  const endpoint = cfg.endpoint || `http://${cfg.host}:${cfg.port}`;
  const res = await fetch(`${endpoint}/?lfc-health`, { headers: { connection: 'close' } });
  if (!res.ok) throw new S3Error('InternalError', res.status, `Health check failed: HTTP ${res.status}`);
  return res.json();
}

export async function listBuckets(cfg) {
  const { body } = await s3Request(cfg, { method: 'GET' });
  const xml = body.toString('utf8');
  const buckets = [];
  const re = /<Bucket><Name>([\s\S]*?)<\/Name><CreationDate>([\s\S]*?)<\/CreationDate><\/Bucket>/g;
  let m;
  while ((m = re.exec(xml)) !== null) buckets.push({ name: unesc(m[1]), creationDate: m[2] });
  return buckets;
}

export async function createBucket(cfg, bucket) {
  await s3Request(cfg, { method: 'PUT', bucket });
  return true;
}

export async function deleteBucket(cfg, bucket, { force = false } = {}) {
  await s3Request(cfg, { method: 'DELETE', bucket, query: force ? { 'lfc-force': '1' } : {} });
  return true;
}

export async function putObject(cfg, bucket, key, data, { contentType, userMeta = {} } = {}) {
  const headers = {};
  if (contentType) headers['content-type'] = contentType;
  for (const [k, v] of Object.entries(userMeta)) headers[`x-amz-meta-${k}`] = v;
  const buf = Buffer.isBuffer(data) ? data : await fsp.readFile(data);
  const { headers: resHeaders } = await s3Request(cfg, { method: 'PUT', bucket, key, body: buf, headers });
  return { etag: (resHeaders.get('etag') || '').replace(/"/g, '') };
}

export async function getObjectBuffer(cfg, bucket, key) {
  const { body, headers } = await s3Request(cfg, { method: 'GET', bucket, key });
  return { body, headers };
}

export async function getObjectToFile(cfg, bucket, key, outFile) {
  const { body, headers } = await s3Request(cfg, { method: 'GET', bucket, key });
  await fsp.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await fsp.writeFile(outFile, body);
  return { size: body.length, etag: (headers.get('etag') || '').replace(/"/g, ''), contentType: headers.get('content-type') };
}

export async function headObject(cfg, bucket, key) {
  const { status, headers } = await s3Request(cfg, { method: 'HEAD', bucket, key });
  const meta = {};
  headers.forEach((v, k) => {
    if (k.startsWith('x-amz-meta-')) meta[k.slice('x-amz-meta-'.length)] = v;
  });
  return {
    status,
    size: Number(headers.get('content-length')) || 0,
    contentType: headers.get('content-type'),
    etag: (headers.get('etag') || '').replace(/"/g, ''),
    lastModified: headers.get('last-modified'),
    userMeta: meta,
  };
}

export async function deleteObject(cfg, bucket, key) {
  await s3Request(cfg, { method: 'DELETE', bucket, key });
  return true;
}

export async function listObjects(cfg, bucket, { prefix = '', delimiter, maxKeys = 1000 } = {}) {
  const query = { 'list-type': '2', 'max-keys': String(maxKeys) };
  if (prefix) query.prefix = prefix;
  if (delimiter) query.delimiter = delimiter;
  const objects = [];
  const prefixes = [];
  let token;
  do {
    const q = { ...query };
    if (token) q['continuation-token'] = token;
    const { body } = await s3Request(cfg, { method: 'GET', bucket, query: q });
    const xml = body.toString('utf8');
    const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = contentsRe.exec(xml)) !== null) {
      const block = m[1];
      objects.push({
        key: unesc(extractOne(block, 'Key') || ''),
        size: Number(extractOne(block, 'Size') || 0),
        lastModified: extractOne(block, 'LastModified') || '',
        etag: (extractOne(block, 'ETag') || '').replace(/"/g, ''),
      });
    }
    const cpRe = /<CommonPrefixes><Prefix>([\s\S]*?)<\/Prefix><\/CommonPrefixes>/g;
    while ((m = cpRe.exec(xml)) !== null) prefixes.push(unesc(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? extractOne(xml, 'NextContinuationToken') : undefined;
  } while (token);
  return { objects, prefixes };
}

export async function deletePrefix(cfg, bucket, prefix) {
  const { objects } = await listObjects(cfg, bucket, { prefix, maxKeys: 1000 });
  let n = 0;
  for (let i = 0; i < objects.length; i += 500) {
    const batch = objects.slice(i, i + 500);
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch.map((o) => `<Object><Key>${o.key.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))}</Key></Object>`).join('')}</Delete>`;
    await s3Request(cfg, { method: 'POST', bucket, query: { delete: '' }, body: Buffer.from(body), headers: { 'content-type': 'application/xml' } });
    n += batch.length;
  }
  return n;
}

export { UNSIGNED_PAYLOAD };
