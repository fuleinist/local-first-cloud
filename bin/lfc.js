#!/usr/bin/env node
// lfc — local-first-cloud CLI. Zero dependencies. Node >= 18.
// NOTE: never call process.exit() with open handles (Windows Node 24 libuv
// crash); set process.exitCode and let the loop drain.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, saveConfig, configPath, genKeys, isAuthConfigured } from '../lib/config.js';
import { createServer } from '../lib/server.js';
import * as client from '../lib/client.js';
import { backup, restore } from '../lib/backup.js';
import { S3Error } from '../lib/store.js';

const HELP = `lfc — local-first-cloud: your own S3-compatible cloud on your machine.

Usage:
  lfc init [--data-dir D] [--port P] [--host H] [--gen-keys]
  lfc start [--host H] [--port P] [--data-dir D]
  lfc status
  lfc mb s3://BUCKET
  lfc rb s3://BUCKET [--force]
  lfc put FILE s3://BUCKET/KEY [--content-type T] [--meta k=v ...]
  lfc get s3://BUCKET/KEY [FILE]
  lfc ls [s3://BUCKET[/PREFIX]] [--long]
  lfc rm s3://BUCKET/KEY [--recursive]
  lfc backup OUTFILE [--passphrase P]
  lfc restore INFILE [--data-dir D] [--passphrase P]

Environment: LFC_DATA_DIR LFC_ENDPOINT LFC_ACCESS_KEY_ID
             LFC_SECRET_ACCESS_KEY LFC_REGION LFC_PASSPHRASE
`;

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.xml': 'application/xml', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
};

function guessContentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(message, code = 1) {
  console.error(`lfc: ${message}`);
  process.exitCode = code;
}

function clientConfig(flags) {
  return loadConfig({
    dataDir: flags['data-dir'] === true ? undefined : flags['data-dir'],
    host: flags.host === true ? undefined : flags.host,
    port: flags.port === true ? undefined : Number(flags.port),
    endpoint: flags.endpoint === true ? undefined : flags.endpoint,
    region: flags.region === true ? undefined : flags.region,
    accessKeyId: flags['access-key-id'] === true ? undefined : flags['access-key-id'],
    secretAccessKey: flags['secret-access-key'] === true ? undefined : flags['secret-access-key'],
    passphrase: flags.passphrase === true ? undefined : flags.passphrase,
  });
}

function printEndpoint(cfg) {
  return cfg.endpoint || `http://${cfg.host}:${cfg.port}`;
}

async function cmdInit(flags) {
  const cfg = clientConfig(flags);
  if (flags['gen-keys'] && !isAuthConfigured(cfg)) {
    Object.assign(cfg, genKeys());
  }
  const file = saveConfig(cfg);
  console.log(`Config written to ${file}`);
  console.log(`  dataDir:  ${cfg.dataDir}`);
  console.log(`  endpoint: ${printEndpoint(cfg)}`);
  console.log(`  region:   ${cfg.region}`);
  if (isAuthConfigured(cfg)) {
    console.log(`  accessKeyId:     ${cfg.accessKeyId}`);
    console.log(`  secretAccessKey: ${cfg.secretAccessKey}`);
    console.log('\nFor aws CLI:');
    console.log(`  aws --endpoint-url ${printEndpoint(cfg)} s3 ls`);
  } else {
    console.log('  auth: anonymous (no keys configured)');
  }
}

async function cmdStart(flags) {
  const cfg = clientConfig(flags);
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  const server = createServer(cfg);
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`port ${cfg.port} is already in use`));
      else reject(err);
    });
    server.listen(cfg.port, cfg.host, resolve);
  });
  const addr = server.address();
  console.log(`local-first-cloud v0.1.0 serving ${cfg.dataDir}`);
  console.log(`  S3 endpoint: http://${addr.address}:${addr.port}`);
  console.log(`  region: ${cfg.region}   auth: ${isAuthConfigured(cfg) ? `SigV4 (${cfg.accessKeyId})` : 'ANONYMOUS - no keys configured!'}`);
  if (!isAuthConfigured(cfg)) {
    console.warn('  WARNING: anonymous mode. Only bind to 127.0.0.1 or a trusted network.');
  }
  const shutdown = () => {
    server.close(() => {});
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus(flags) {
  const cfg = clientConfig(flags);
  try {
    const h = await client.health(cfg);
    console.log(`OK  ${printEndpoint(cfg)}`);
    console.log(`  version: ${h.version}  auth: ${h.auth}  dataDir: ${h.dataDir}`);
  } catch (err) {
    fail(`server not reachable at ${printEndpoint(cfg)} (${err.message})`);
  }
}

async function cmdMb(flags) {
  const cfg = clientConfig(flags);
  const { bucket } = client.parseS3Url(flags._args[0]);
  await client.createBucket(cfg, bucket);
  console.log(`make_bucket: ${bucket}`);
}

async function cmdRb(flags) {
  const cfg = clientConfig(flags);
  const { bucket } = client.parseS3Url(flags._args[0]);
  await client.deleteBucket(cfg, bucket, { force: Boolean(flags.force) });
  console.log(`remove_bucket: ${bucket}`);
}

async function cmdPut(flags) {
  const cfg = clientConfig(flags);
  const [file, s3url] = flags._args;
  if (!file || !s3url) throw new S3Error('InvalidArgument', 400, 'Usage: lfc put FILE s3://BUCKET/KEY');
  const { bucket, key } = client.parseS3Url(s3url);
  const objectKey = key || path.basename(file);
  const contentType = flags['content-type'] && flags['content-type'] !== true ? flags['content-type'] : guessContentType(file);
  const userMeta = {};
  const metas = [].concat(flags.meta || []);
  for (const m of metas.filter((x) => x !== true)) {
    const i = m.indexOf('=');
    if (i > 0) userMeta[m.slice(0, i)] = m.slice(i + 1);
  }
  const { etag } = await client.putObject(cfg, bucket, objectKey, file, { contentType, userMeta });
  const st = await fsp.stat(file);
  console.log(`upload: ${file} -> s3://${bucket}/${objectKey} (${st.size} bytes, etag ${etag})`);
}

async function cmdGet(flags) {
  const cfg = clientConfig(flags);
  const [s3url, outArg] = flags._args;
  const { bucket, key } = client.parseS3Url(s3url);
  if (!key) throw new S3Error('InvalidArgument', 400, 'Usage: lfc get s3://BUCKET/KEY [FILE]');
  const outFile = outArg || path.basename(key);
  const { size } = await client.getObjectToFile(cfg, bucket, key, outFile);
  console.log(`download: s3://${bucket}/${key} -> ${outFile} (${size} bytes)`);
}

async function cmdLs(flags) {
  const cfg = clientConfig(flags);
  const spec = flags._args[0];
  const long = Boolean(flags.long);
  if (!spec) {
    const buckets = await client.listBuckets(cfg);
    for (const b of buckets) console.log(b.name);
    if (!buckets.length) console.log('(no buckets)');
    return;
  }
  const { bucket, key } = client.parseS3Url(spec);
  const { objects, prefixes } = await client.listObjects(cfg, bucket, { prefix: key, delimiter: '/' });
  for (const p of prefixes) console.log(`                           PRE ${p}`);
  for (const o of objects) {
    if (long) {
      console.log(`${new Date(o.lastModified).toISOString()}  ${String(o.size).padStart(10)}  ${o.key}`);
    } else {
      console.log(o.key);
    }
  }
  if (!objects.length && !prefixes.length) console.log('(empty)');
}

async function cmdRm(flags) {
  const cfg = clientConfig(flags);
  const { bucket, key } = client.parseS3Url(flags._args[0]);
  if (flags.recursive) {
    const n = await client.deletePrefix(cfg, bucket, key);
    console.log(`delete: s3://${bucket}/${key} (${n} objects, recursive)`);
  } else {
    if (!key) throw new S3Error('InvalidArgument', 400, 'Usage: lfc rm s3://BUCKET/KEY [--recursive]');
    await client.deleteObject(cfg, bucket, key);
    console.log(`delete: s3://${bucket}/${key}`);
  }
}

async function cmdBackup(flags) {
  const cfg = clientConfig(flags);
  const outFile = flags._args[0];
  if (!outFile) throw new S3Error('InvalidArgument', 400, 'Usage: lfc backup OUTFILE [--passphrase P]');
  const passphrase = typeof flags.passphrase === 'string' ? flags.passphrase : cfg.passphrase;
  const res = await backup({ dataDir: cfg.dataDir, outFile, passphrase });
  console.log(`backup: ${res.entries} files (${res.bytes} bytes) -> ${res.file}`);
}

async function cmdRestore(flags) {
  const cfg = clientConfig(flags);
  const inFile = flags._args[0];
  if (!inFile) throw new S3Error('InvalidArgument', 400, 'Usage: lfc restore INFILE [--data-dir D] [--passphrase P]');
  const passphrase = typeof flags.passphrase === 'string' ? flags.passphrase : cfg.passphrase;
  const res = await restore({ file: inFile, dataDir: cfg.dataDir, passphrase });
  console.log(`restore: ${res.entries} files (${res.bytes} bytes) -> ${res.dataDir}`);
}

const COMMANDS = {
  init: cmdInit,
  start: cmdStart,
  status: cmdStatus,
  mb: cmdMb,
  rb: cmdRb,
  put: cmdPut,
  get: cmdGet,
  ls: cmdLs,
  rm: cmdRm,
  backup: cmdBackup,
  restore: cmdRestore,
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  if (!command || flags.help || command === 'help') {
    console.log(HELP);
    return;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    console.log(HELP);
    process.exitCode = 1;
    console.error(`lfc: unknown command '${command}'`);
    return;
  }
  flags._args = positional;
  try {
    await fn(flags);
  } catch (err) {
    if (err instanceof S3Error || err.code) {
      fail(`[${err.code || 'Error'}] ${err.message}`, err.status === 404 ? 2 : 1);
    } else {
      fail(err.message);
    }
  }
}

await main();
