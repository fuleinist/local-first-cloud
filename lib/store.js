// Filesystem-backed S3 object store.
// Layout: <dataDir>/buckets/<bucket>/<key>  +  <dataDir>/meta/<bucket>/<key>.json

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { md5hex } from './sigv4.js';

export class S3Error extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/;
const MAX_KEY_BYTES = 1024;

export function validateBucket(name) {
  if (typeof name !== 'string' || !BUCKET_RE.test(name) || name.includes('..') || name.includes('-.') || name.includes('.-')) {
    throw new S3Error('InvalidBucketName', 400, `The specified bucket is not valid: ${name}`);
  }
  return name;
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new S3Error('InvalidArgument', 400, 'Object key must be a non-empty string');
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new S3Error('KeyTooLongError', 400, 'Object key exceeds 1024 bytes');
  }
  if (key.startsWith('/') || key.includes('\\')) {
    throw new S3Error('InvalidArgument', 400, 'Object key must be relative and use forward slashes');
  }
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new S3Error('InvalidArgument', 400, `Object key contains an invalid segment: ${key}`);
    }
  }
  return key;
}

export class Store {
  constructor(dataDir) {
    if (!dataDir) throw new Error('Store requires a dataDir');
    this.dataDir = path.resolve(dataDir);
    this.bucketsDir = path.join(this.dataDir, 'buckets');
    this.metaDir = path.join(this.dataDir, 'meta');
  }

  async init() {
    await fsp.mkdir(this.bucketsDir, { recursive: true });
    await fsp.mkdir(this.metaDir, { recursive: true });
  }

  bucketPath(bucket) {
    validateBucket(bucket);
    const p = path.resolve(path.join(this.bucketsDir, bucket));
    if (p !== path.join(this.bucketsDir, bucket) && !p.startsWith(this.bucketsDir + path.sep)) {
      throw new S3Error('InvalidBucketName', 400, 'Bucket path escapes data directory');
    }
    return p;
  }

  objectPath(bucket, key) {
    validateKey(key);
    const base = this.bucketPath(bucket);
    const p = path.resolve(path.join(base, ...key.split('/')));
    if (p !== base && !p.startsWith(base + path.sep)) {
      throw new S3Error('InvalidArgument', 400, 'Object key escapes bucket directory');
    }
    return p;
  }

  metaPath(bucket, key) {
    validateKey(key);
    const base = path.resolve(path.join(this.metaDir, validateBucket(bucket)));
    const p = path.resolve(path.join(base, ...key.split('/')) + '.json');
    if (!p.startsWith(base + path.sep)) {
      throw new S3Error('InvalidArgument', 400, 'Object key escapes meta directory');
    }
    return p;
  }

  // ---- buckets ----

  async createBucket(bucket) {
    validateBucket(bucket);
    await fsp.mkdir(this.bucketsDir, { recursive: true });
    await fsp.mkdir(this.metaDir, { recursive: true });
    const p = this.bucketPath(bucket);
    try {
      await fsp.mkdir(p, { recursive: false });
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new S3Error('BucketAlreadyOwnedByYou', 409, 'Your previous request to create the named bucket succeeded and you already own it.');
      }
      throw err;
    }
    await fsp.mkdir(path.join(this.metaDir, bucket), { recursive: true });
    return { location: `/${bucket}` };
  }

  async headBucket(bucket) {
    validateBucket(bucket);
    const p = this.bucketPath(bucket);
    try {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
    } catch (err) {
      if (err.code === 'ENOENT') throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
      throw err;
    }
    return true;
  }

  async deleteBucket(bucket, { force = false } = {}) {
    validateBucket(bucket);
    const p = this.bucketPath(bucket);
    try {
      await fsp.stat(p);
    } catch (err) {
      if (err.code === 'ENOENT') throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
      throw err;
    }
    if (force) {
      const keys = await this.listAllKeys(bucket);
      if (keys.length) await this.deleteObjects(bucket, keys);
      await fsp.rm(p, { recursive: true, force: true });
      await fsp.rm(path.join(this.metaDir, bucket), { recursive: true, force: true });
      return true;
    }
    const entries = await fsp.readdir(p);
    if (entries.length > 0) {
      throw new S3Error('BucketNotEmpty', 409, 'The bucket you tried to delete is not empty');
    }
    await fsp.rmdir(p);
    await fsp.rm(path.join(this.metaDir, bucket), { recursive: true, force: true });
    return true;
  }

  async listBuckets() {
    await this.init();
    let entries;
    try {
      entries = await fsp.readdir(this.bucketsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const buckets = [];
    for (const e of entries) {
      if (!e.isDirectory() || !BUCKET_RE.test(e.name)) continue;
      let creationDate;
      try {
        const st = await fsp.stat(path.join(this.bucketsDir, e.name));
        creationDate = (st.birthtimeMs && !Number.isNaN(st.birthtimeMs) ? st.birthtime : st.mtime).toISOString();
      } catch {
        creationDate = new Date(0).toISOString();
      }
      buckets.push({ name: e.name, creationDate });
    }
    buckets.sort((a, b) => a.name.localeCompare(b.name));
    return buckets;
  }

  // ---- objects ----

  async putObject(bucket, key, body, { contentType = 'application/octet-stream', userMeta = {} } = {}) {
    const p = this.objectPath(bucket, key);
    await this.headBucket(bucket).catch(() => {
      throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
    });
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const etag = md5hex(buf);
    const tmp = p + '.lfc-tmp-' + crypto.randomBytes(6).toString('hex');
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, p);
    const meta = {
      contentType,
      etag,
      size: buf.length,
      userMeta,
      createdAt: new Date().toISOString(),
    };
    const mp = this.metaPath(bucket, key);
    await fsp.mkdir(path.dirname(mp), { recursive: true });
    await fsp.writeFile(mp, JSON.stringify(meta));
    return meta;
  }

  async getMeta(bucket, key) {
    const mp = this.metaPath(bucket, key);
    try {
      return JSON.parse(await fsp.readFile(mp, 'utf8'));
    } catch {
      // Fall back to file stat when sidecar is missing
      const p = this.objectPath(bucket, key);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) throw new Error('not a file');
        return {
          contentType: 'application/octet-stream',
          etag: md5hex(await fsp.readFile(p)),
          size: st.size,
          userMeta: {},
          createdAt: st.mtime.toISOString(),
        };
      } catch {
        throw new S3Error('NoSuchKey', 404, 'The specified key does not exist.');
      }
    }
  }

  async getObjectFile(bucket, key) {
    const p = this.objectPath(bucket, key);
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) throw new Error('not a file');
      return { path: p, stat: st };
    } catch {
      throw new S3Error('NoSuchKey', 404, 'The specified key does not exist.');
    }
  }

  async getObjectBuffer(bucket, key) {
    const { path: p } = await this.getObjectFile(bucket, key);
    return fsp.readFile(p);
  }

  async deleteObject(bucket, key) {
    const p = this.objectPath(bucket, key);
    const mp = this.metaPath(bucket, key);
    try {
      await fsp.rm(p, { force: true });
      await fsp.rm(mp, { force: true });
      await this.pruneEmptyDirs(path.dirname(p), this.bucketPath(bucket));
      await this.pruneEmptyDirs(path.dirname(mp), path.join(this.metaDir, bucket));
    } catch {
      // S3 delete is idempotent; ignore
    }
    return true;
  }

  async deleteObjects(bucket, keys) {
    const deleted = [];
    for (const key of keys) {
      try {
        validateKey(key);
        await this.deleteObject(bucket, key);
        deleted.push(key);
      } catch {
        deleted.push(key); // S3 reports delete success even for missing keys
      }
    }
    return deleted;
  }

  async copyObject(srcBucket, srcKey, dstBucket, dstKey) {
    const buf = await this.getObjectBuffer(srcBucket, srcKey);
    const srcMeta = await this.getMeta(srcBucket, srcKey);
    return this.putObject(dstBucket, dstKey, buf, {
      contentType: srcMeta.contentType,
      userMeta: srcMeta.userMeta,
    });
  }

  async pruneEmptyDirs(dir, stopAt) {
    let cur = path.resolve(dir);
    const stop = path.resolve(stopAt);
    while (cur.startsWith(stop + path.sep)) {
      try {
        const entries = await fsp.readdir(cur);
        if (entries.length > 0) break;
        await fsp.rmdir(cur);
        cur = path.dirname(cur);
      } catch {
        break;
      }
    }
  }

  // ---- listing ----

  async listAllKeys(bucket) {
    const base = this.bucketPath(bucket);
    const keys = [];
    const walk = async (dir, rel) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.endsWith('.lfc-tmp-') || e.name.includes('.lfc-tmp-')) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.isFile()) keys.push(r);
      }
    };
    await walk(base, '');
    keys.sort();
    return keys;
  }

  async list(bucket, { prefix = '', delimiter, maxKeys = 1000, startAfter } = {}) {
    await this.headBucket(bucket);
    const max = Math.max(0, Math.min(Number(maxKeys) || 0, 1000));
    const all = await this.listAllKeys(bucket);
    const contents = [];
    const commonPrefixes = new Set();
    let truncated = false;
    let nextToken;
    let lastKey;
    for (const key of all) {
      if (startAfter !== undefined && key <= startAfter) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = prefix ? key.slice(prefix.length) : key;
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          commonPrefixes.add((prefix || '') + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      if (contents.length >= max) {
        truncated = true;
        nextToken = Buffer.from(lastKey, 'utf8').toString('base64url');
        break;
      }
      let size = 0;
      let lastModified;
      let etag = '';
      try {
        const st = await fsp.stat(this.objectPath(bucket, key));
        size = st.size;
        lastModified = st.mtime.toISOString();
      } catch {
        lastModified = new Date(0).toISOString();
      }
      try {
        const meta = JSON.parse(await fsp.readFile(this.metaPath(bucket, key), 'utf8'));
        etag = meta.etag || '';
        if (lastModified === new Date(0).toISOString() && meta.createdAt) lastModified = meta.createdAt;
      } catch {
        // leave etag empty
      }
      contents.push({ key, size, lastModified, etag, storageClass: 'STANDARD' });
      lastKey = key;
    }
    const sortedPrefixes = [...commonPrefixes].sort();
    return {
      contents,
      commonPrefixes: sortedPrefixes,
      isTruncated: truncated,
      nextContinuationToken: nextToken,
    };
  }
}

export function decodeKeyFromPath(pathname) {
  // pathname like /bucket/a/b%20c -> { bucket, key }
  const segs = pathname.split('/').filter((s, i) => !(i === 0 && s === ''));
  const decoded = segs.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const bucket = decoded[0];
  const key = decoded.slice(1).join('/');
  return { bucket, key };
}
