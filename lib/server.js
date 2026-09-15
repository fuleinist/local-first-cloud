// S3-compatible HTTP server over the local filesystem Store.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Store, S3Error, validateBucket, validateKey, decodeKeyFromPath } from './store.js';
import { verifyRequest, AuthError, UNSIGNED_PAYLOAD } from './sigv4.js';
import { xmlDoc, tag, esc, errorXml, parseDeleteBody } from './xml.js';
import { isAuthConfigured } from './config.js';

const MAX_KEYS_DEFAULT = 1000;

function requestId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function sendXml(res, status, xml, headers = {}) {
  const body = Buffer.from(xml, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/xml',
    'Content-Length': body.length,
    'x-amz-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function sendError(res, err, resource) {
  const code = err.code || 'InternalError';
  const status = err.status || 500;
  const message = err.message || code;
  sendXml(res, status, errorXml({ code, message, resource }));
}

function sendNotImplemented(res, what) {
  sendXml(res, 501, errorXml({
    code: 'NotImplemented',
    message: `${what} is not supported in local-first-cloud v0.1.0 (see SPEC.md)`,
  }));
}

function httpDate(d) {
  return new Date(d).toUTCString();
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new S3Error('EntityTooLarge', 400, `Request body exceeds maxBodyBytes (${maxBytes})`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function userMetaFromHeaders(headers) {
  const meta = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-amz-meta-')) meta[k.slice('x-amz-meta-'.length)] = v;
  }
  return meta;
}

export function createServer(config = {}) {
  const store = new Store(config.dataDir);
  const authEnabled = isAuthConfigured(config);
  const maxBodyBytes = config.maxBodyBytes || 100 * 1024 * 1024;
  const region = config.region || 'us-east-1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    try {
      // Health endpoint (unauthenticated)
      if (pathname === '/' && url.searchParams.has('lfc-health')) {
        const body = JSON.stringify({
          ok: true,
          service: 'local-first-cloud',
          version: '0.1.0',
          auth: authEnabled ? 'sigv4' : 'anonymous',
          dataDir: store.dataDir,
          time: new Date().toISOString(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      const body = method === 'GET' || method === 'HEAD' || method === 'DELETE'
        ? Buffer.alloc(0)
        : await readBody(req, maxBodyBytes);

      // Auth
      if (authEnabled) {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
        }
        try {
          verifyRequest({
            method,
            path: pathname,
            query: url.search,
            headers,
            body,
            getSecret: (accessKeyId) => (accessKeyId === config.accessKeyId ? config.secretAccessKey : null),
            region,
          });
        } catch (err) {
          if (err instanceof AuthError) {
            sendError(res, new S3Error(err.code, err.status, err.message), pathname);
            return;
          }
          throw err;
        }
      }

      await route(req, res, url, method, body);
    } catch (err) {
      if (!res.headersSent) sendError(res, err, pathname);
      else res.destroy();
    }
  });

  async function route(req, res, url, method, body) {
    const pathname = url.pathname;
    const q = url.searchParams;

    if (pathname === '/' || pathname === '') {
      if (method === 'GET') return listBuckets(res);
      if (method === 'POST' && q.has('lfc-shutdown')) {
        res.writeHead(200).end('bye');
        server.close();
        return;
      }
      return sendNotImplemented(res, `${method} /`);
    }

    const { bucket, key } = decodeKeyFromPath(pathname);

    if (!key) {
      // Bucket-level operations
      if (method === 'PUT') return createBucket(res, bucket);
      if (method === 'HEAD') return headBucket(res, bucket);
      if (method === 'DELETE') return deleteBucket(res, bucket, url);
      if (method === 'GET') {
        if (q.has('acl')) return getBucketAcl(res, bucket);
        return listObjects(res, bucket, q);
      }
      if (method === 'POST' && q.has('delete')) return deleteObjects(res, bucket, body);
      return sendNotImplemented(res, `${method} /${bucket}`);
    }

    // Object-level operations
    if (method === 'PUT') {
      if (req.headers['x-amz-copy-source']) return copyObject(res, req, bucket, key);
      return putObject(res, req, bucket, key, body);
    }
    if (method === 'GET') return getObject(res, bucket, key, false);
    if (method === 'HEAD') return getObject(res, bucket, key, true);
    if (method === 'DELETE') return deleteObject(res, bucket, key);
    return sendNotImplemented(res, `${method} object`);
  }

  // ---- bucket ops ----

  async function listBuckets(res) {
    const buckets = await store.listBuckets();
    const xml = xmlDoc(tag('ListAllMyBucketsResult', [
      tag('Owner', tag('ID', esc('local-first-cloud')) + tag('DisplayName', esc('owner'))),
      tag('Buckets', buckets.map((b) => tag('Bucket', tag('Name', esc(b.name)) + tag('CreationDate', esc(b.creationDate)))).join('')),
    ].join(''), { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' }));
    sendXml(res, 200, xml);
  }

  async function createBucket(res, bucket) {
    validateBucket(bucket);
    const { location } = await store.createBucket(bucket);
    res.writeHead(200, { Location: location, 'x-amz-bucket-region': region });
    res.end();
  }

  async function headBucket(res, bucket) {
    await store.headBucket(bucket);
    res.writeHead(200, { 'x-amz-bucket-region': region });
    res.end();
  }

  async function deleteBucket(res, bucket, url) {
    const force = url.searchParams.get('lfc-force') === '1';
    await store.deleteBucket(bucket, { force });
    res.writeHead(204);
    res.end();
  }

  async function getBucketAcl(res, bucket) {
    await store.headBucket(bucket);
    const xml = xmlDoc(tag('AccessControlPolicy', [
      tag('Owner', tag('ID', esc('local-first-cloud')) + tag('DisplayName', esc('owner'))),
      tag('AccessControlList', tag('Grant', [
        tag('Grantee', tag('ID', esc('local-first-cloud')) + tag('DisplayName', esc('owner')), { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xsi:type': 'CanonicalUser' }),
        tag('Permission', 'FULL_CONTROL'),
      ].join(''))),
    ].join(''), { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' }));
    sendXml(res, 200, xml);
  }

  async function listObjects(res, bucket, q) {
    const v2 = q.get('list-type') === '2';
    const prefix = q.get('prefix') || '';
    const delimiter = q.get('delimiter') || undefined;
    const maxKeys = Math.min(Number(q.get('max-keys')) || MAX_KEYS_DEFAULT, MAX_KEYS_DEFAULT);
    let startAfter;
    if (v2) {
      const token = q.get('continuation-token');
      if (token) {
        try {
          startAfter = Buffer.from(token, 'base64url').toString('utf8');
        } catch {
          throw new S3Error('InvalidArgument', 400, 'Invalid continuation token');
        }
      } else if (q.get('start-after')) {
        startAfter = q.get('start-after');
      }
    } else {
      const marker = q.get('marker');
      if (marker) startAfter = marker;
    }

    const result = await store.list(bucket, { prefix, delimiter, maxKeys, startAfter });

    const contentsXml = result.contents.map((o) => tag('Contents', [
      tag('Key', esc(o.key)),
      tag('LastModified', esc(o.lastModified)),
      o.etag ? tag('ETag', esc(`"${o.etag}"`)) : '',
      tag('Size', String(o.size)),
      tag('StorageClass', esc(o.storageClass)),
    ].join(''))).join('');
    const prefixesXml = result.commonPrefixes.map((p) => tag('CommonPrefixes', tag('Prefix', esc(p)))).join('');

    let xml;
    if (v2) {
      xml = xmlDoc(tag('ListBucketResult', [
        tag('Name', esc(bucket)),
        tag('Prefix', esc(prefix)),
        tag('KeyCount', String(result.contents.length + result.commonPrefixes.length)),
        tag('MaxKeys', String(maxKeys)),
        delimiter ? tag('Delimiter', esc(delimiter)) : '',
        tag('IsTruncated', String(result.isTruncated)),
        q.get('continuation-token') ? tag('ContinuationToken', esc(q.get('continuation-token'))) : '',
        result.isTruncated && result.nextContinuationToken ? tag('NextContinuationToken', esc(result.nextContinuationToken)) : '',
        contentsXml,
        prefixesXml,
      ].join(''), { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' }));
    } else {
      xml = xmlDoc(tag('ListBucketResult', [
        tag('Name', esc(bucket)),
        tag('Prefix', esc(prefix)),
        tag('Marker', esc(q.get('marker') || '')),
        tag('MaxKeys', String(maxKeys)),
        delimiter ? tag('Delimiter', esc(delimiter)) : '',
        tag('IsTruncated', String(result.isTruncated)),
        result.isTruncated ? tag('NextMarker', esc(result.nextContinuationToken
          ? Buffer.from(result.nextContinuationToken, 'base64url').toString('utf8')
          : (result.contents[result.contents.length - 1]?.key || ''))) : '',
        contentsXml,
        prefixesXml,
      ].join(''), { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' }));
    }
    sendXml(res, 200, xml);
  }

  async function deleteObjects(res, bucket, body) {
    await store.headBucket(bucket);
    const { quiet, keys } = parseDeleteBody(body.toString('utf8'));
    for (const k of keys) validateKey(k);
    const deleted = await store.deleteObjects(bucket, keys);
    const xml = xmlDoc(tag('DeleteResult', deleted
      .filter(() => !quiet)
      .map((k) => tag('Deleted', tag('Key', esc(k))))
      .join(''), { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' }));
    sendXml(res, 200, xml);
  }

  // ---- object ops ----

  async function putObject(res, req, bucket, key, body) {
    await store.headBucket(bucket);
    validateKey(key);
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    const userMeta = userMetaFromHeaders(req.headers);
    const meta = await store.putObject(bucket, key, body, { contentType, userMeta });
    res.writeHead(200, { ETag: `"${meta.etag}"` });
    res.end();
  }

  async function copyObject(res, req, bucket, key) {
    await store.headBucket(bucket);
    validateKey(key);
    const src = decodeURIComponent(req.headers['x-amz-copy-source']);
    const srcPath = src.startsWith('/') ? src.slice(1) : src;
    const idx = srcPath.indexOf('/');
    if (idx < 0) throw new S3Error('InvalidArgument', 400, 'Invalid x-amz-copy-source');
    const srcBucket = srcPath.slice(0, idx);
    const srcKey = srcPath.slice(idx + 1);
    const meta = await store.copyObject(srcBucket, srcKey, bucket, key);
    const xml = xmlDoc(tag('CopyObjectResult', [
      tag('LastModified', esc(new Date().toISOString())),
      tag('ETag', esc(`"${meta.etag}"`)),
    ].join(''), { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' }));
    sendXml(res, 200, xml);
  }

  async function getObject(res, bucket, key, headOnly) {
    validateKey(key);
    const file = await store.getObjectFile(bucket, key);
    const meta = await store.getMeta(bucket, key);
    const headers = {
      'Content-Type': meta.contentType || 'application/octet-stream',
      'Content-Length': file.stat.size,
      ETag: `"${meta.etag}"`,
      'Last-Modified': httpDate(file.stat.mtime),
      'Accept-Ranges': 'none',
      'x-amz-request-id': requestId(),
    };
    for (const [k, v] of Object.entries(meta.userMeta || {})) {
      headers[`x-amz-meta-${k}`] = v;
    }
    if (headOnly) {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(file.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function deleteObject(res, bucket, key) {
    validateKey(key);
    await store.deleteObject(bucket, key);
    res.writeHead(204);
    res.end();
  }

  return server;
}

export async function startServer(config) {
  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  return server;
}
