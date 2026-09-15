// Encrypted backup/restore of the data directory.
// Archive format (see SPEC.md): "LFCK" | u32 headerLen | header JSON |
// entries: u32 pathLen | path | u64 size | 12B IV | ciphertext | 16B tag |
// terminator u32 pathLen=0.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const MAGIC = 'LFCK';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const IV_LEN = 12;
const TAG_LEN = 16;
const CHUNK = 64 * 1024;

export function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2,
  });
}

async function* walkFiles(dir, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0 && rel) {
    yield { rel, isDir: true }; // preserve empty dirs (e.g. empty buckets)
    return;
  }
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) yield* walkFiles(path.join(dir, e.name), r);
    else if (e.isFile()) yield { rel: r, isDir: false };
  }
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

export async function backup({ dataDir, outFile, passphrase }) {
  if (!passphrase) throw new Error('A passphrase is required for backup (LFC_PASSPHRASE or --passphrase)');
  const dataDirResolved = path.resolve(dataDir);
  try {
    await fsp.stat(dataDirResolved);
  } catch {
    throw new Error(`Data directory not found: ${dataDirResolved}`);
  }
  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const header = {
    v: 1,
    kdf: { name: 'scrypt', ...SCRYPT_PARAMS, salt: salt.toString('hex') },
    cipher: 'aes-256-gcm',
    createdAt: new Date().toISOString(),
    node: os.hostname(),
    source: dataDirResolved,
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');

  await fsp.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  const out = fs.createWriteStream(outFile);
  const write = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  await write(Buffer.from(MAGIC, 'ascii'));
  await write(u32(headerJson.length));
  await write(headerJson);

  let count = 0;
  let bytes = 0;
  for await (const entry of walkFiles(dataDirResolved)) {
    const rel = entry.isDir ? entry.rel + '/' : entry.rel;
    const relBuf = Buffer.from(rel, 'utf8');
    const iv = crypto.randomBytes(IV_LEN);
    await write(u32(relBuf.length));
    await write(relBuf);
    if (entry.isDir) {
      await write(u64(0));
      await write(iv);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const fin = cipher.final();
      if (fin.length) await write(fin);
      await write(cipher.getAuthTag());
      count++;
      continue;
    }
    const srcPath = path.join(dataDirResolved, ...entry.rel.split('/'));
    const st = await fsp.stat(srcPath);
    await write(u64(st.size));
    await write(iv);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const inStream = fs.createReadStream(srcPath, { highWaterMark: CHUNK });
    for await (const chunk of inStream) {
      const enc = cipher.update(chunk);
      if (enc.length) await write(enc);
      bytes += chunk.length;
    }
    const fin = cipher.final();
    if (fin.length) await write(fin);
    await write(cipher.getAuthTag());
    count++;
  }
  await write(u32(0));
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return { file: path.resolve(outFile), entries: count, bytes };
}

// Sequential reader over a file handle.
class SeqReader {
  constructor(fh) {
    this.fh = fh;
    this.pos = 0;
  }
  async read(len) {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await this.fh.read(buf, got, len - got, this.pos + got);
      if (bytesRead === 0) throw new Error('Unexpected end of archive');
      got += bytesRead;
    }
    this.pos += len;
    return buf;
  }
  async readU32() {
    return (await this.read(4)).readUInt32BE(0);
  }
  async readU64() {
    return Number((await this.read(8)).readBigUInt64BE(0));
  }
}

function safeRel(rel) {
  const isDir = rel.endsWith('/');
  const clean = isDir ? rel.slice(0, -1) : rel;
  if (!clean || clean.startsWith('/') || clean.includes('\\') || clean.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Archive contains an unsafe path: ${rel}`);
  }
  return { clean, isDir };
}

export async function restore({ file, dataDir, passphrase }) {
  if (!passphrase) throw new Error('A passphrase is required for restore (LFC_PASSPHRASE or --passphrase)');
  const fh = await fsp.open(file, 'r');
  const staging = path.resolve(dataDir) + '.lfc-restore-' + crypto.randomBytes(4).toString('hex');
  let count = 0;
  let bytes = 0;
  try {
    const reader = new SeqReader(fh);
    const magic = (await reader.read(4)).toString('ascii');
    if (magic !== MAGIC) throw new Error('Not a local-first-cloud archive (bad magic)');
    const headerLen = await reader.readU32();
    if (headerLen > 1024 * 1024) throw new Error('Archive header too large');
    const header = JSON.parse((await reader.read(headerLen)).toString('utf8'));
    if (header.v !== 1) throw new Error(`Unsupported archive version: ${header.v}`);
    if (header.cipher !== 'aes-256-gcm' || header.kdf?.name !== 'scrypt') {
      throw new Error('Unsupported archive cipher/kdf');
    }
    const salt = Buffer.from(header.kdf.salt, 'hex');
    const key = deriveKey(passphrase, salt);
    await fsp.mkdir(staging, { recursive: true });

    for (;;) {
      const pathLen = await reader.readU32();
      if (pathLen === 0) break;
      if (pathLen > 4096) throw new Error('Archive path entry too long');
      const { clean, isDir } = safeRel((await reader.read(pathLen)).toString('utf8'));
      const size = await reader.readU64();
      const iv = await reader.read(IV_LEN);
      const outPath = path.join(staging, ...clean.split('/'));
      if (isDir) {
        if (size !== 0) throw new Error('Directory entry with non-zero size');
        const tag = await reader.read(TAG_LEN);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        decipher.final(); // authenticates the empty entry
        await fsp.mkdir(outPath, { recursive: true });
        count++;
        continue;
      }
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      const out = fs.createWriteStream(outPath);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      let remaining = size;
      let written = 0;
      while (remaining > 0) {
        const n = Math.min(CHUNK, remaining);
        const ct = await reader.read(n);
        const pt = decipher.update(ct);
        await new Promise((resolve, reject) => out.write(pt, (e) => (e ? reject(e) : resolve())));
        written += pt.length;
        remaining -= n;
      }
      const tag = await reader.read(TAG_LEN);
      decipher.setAuthTag(tag);
      const fin = decipher.final(); // throws on bad passphrase / tampering
      if (fin.length) {
        await new Promise((resolve, reject) => out.write(fin, (e) => (e ? reject(e) : resolve())));
        written += fin.length;
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (written !== size) throw new Error(`Size mismatch restoring ${clean}`);
      count++;
      bytes += written;
    }
  } catch (err) {
    await fh.close();
    await fsp.rm(staging, { recursive: true, force: true });
    if (err.message && /Unsupported state or unable to authenticate data/i.test(err.message)) {
      throw new Error('Restore failed: wrong passphrase or tampered archive');
    }
    throw err;
  }
  await fh.close();

  // Swap staging into place. Target must be absent or empty.
  const target = path.resolve(dataDir);
  try {
    const entries = await fsp.readdir(target);
    if (entries.length > 0) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw new Error(`Refusing to restore into non-empty directory: ${target}`);
    }
    await fsp.rm(target, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (err.message?.startsWith('Refusing')) throw err;
    }
  }
  await fsp.rename(staging, target);
  return { dataDir: target, entries: count, bytes };
}
