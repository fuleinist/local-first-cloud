// End-to-end CLI smoke tests: spawn `node bin/lfc.js` against a real server.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LFC = path.join(__dirname, '..', 'bin', 'lfc.js');

let tmp;
let home;
let endpoint;
let serverProc;

function lfc(args, opts = {}) {
  return spawnSync(process.execPath, [LFC, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LFC_HOME: home, LFC_ENDPOINT: endpoint, ...opts.env },
    timeout: 30000,
    ...opts,
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-cli-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  // init writes config with generated keys
  const init = lfc(['init', '--gen-keys', '--port', '0']);
  assert.equal(init.status, 0, init.stderr);
  // start server on a free-ish high port
  const port = 19100 + Math.floor(Math.random() * 800);
  endpoint = `http://127.0.0.1:${port}`;
  const { spawn } = await import('node:child_process');
  serverProc = spawn(process.execPath, [LFC, 'start', '--port', String(port)], {
    env: { ...process.env, LFC_HOME: home, LFC_ENDPOINT: endpoint },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for server to accept connections
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${endpoint}/?lfc-health`, { headers: { connection: 'close' } });
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('CLI test server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  if (serverProc && !serverProc.killed) serverProc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--help prints usage', () => {
  const res = lfc(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /local-first-cloud/);
  assert.match(res.stdout, /lfc start/);
});

test('status reports healthy server', () => {
  const res = lfc(['status']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^OK/);
});

test('mb/put/ls/get/rm/rb lifecycle via CLI', () => {
  let res = lfc(['mb', 's3://cli-bucket']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /make_bucket: cli-bucket/);

  const src = path.join(tmp, 'hello.txt');
  fs.writeFileSync(src, 'hello from the cli');
  res = lfc(['put', src, 's3://cli-bucket/greet/hello.txt']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /upload: .*hello\.txt -> s3:\/\/cli-bucket\/greet\/hello\.txt \(18 bytes/);

  res = lfc(['ls', 's3://cli-bucket']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /greet\//); // delimiter shows PRE greet/

  res = lfc(['ls', 's3://cli-bucket/greet/', '--long']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /hello\.txt/);

  const dst = path.join(tmp, 'out.txt');
  res = lfc(['get', 's3://cli-bucket/greet/hello.txt', dst]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(dst, 'utf8'), 'hello from the cli');

  res = lfc(['rm', 's3://cli-bucket/greet/hello.txt']);
  assert.equal(res.status, 0, res.stderr);

  res = lfc(['rb', 's3://cli-bucket']);
  assert.equal(res.status, 0, res.stderr);
});

test('rm --recursive removes a prefix', () => {
  let res = lfc(['mb', 's3://rec-bucket']);
  assert.equal(res.status, 0, res.stderr);
  const f = path.join(tmp, 'r.txt');
  fs.writeFileSync(f, 'r');
  for (const k of ['dir/a', 'dir/b', 'top']) {
    res = lfc(['put', f, `s3://rec-bucket/${k}`]);
    assert.equal(res.status, 0, res.stderr);
  }
  res = lfc(['rm', 's3://rec-bucket/dir/', '--recursive']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /2 objects/);
  res = lfc(['ls', 's3://rec-bucket']);
  assert.match(res.stdout, /top/);
  assert.ok(!res.stdout.includes('dir/'));
  res = lfc(['rb', 's3://rec-bucket', '--force']);
  assert.equal(res.status, 0, res.stderr);
});

test('get missing key exits non-zero with NoSuchKey', () => {
  const res = lfc(['mb', 's3://err-bucket']);
  assert.equal(res.status, 0, res.stderr);
  const r2 = lfc(['get', 's3://err-bucket/nope.txt', path.join(tmp, 'nope.out')]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /NoSuchKey/);
  lfc(['rb', 's3://err-bucket']);
});

test('backup and restore via CLI', () => {
  const archive = path.join(tmp, 'cli-backup.lfcb');
  const res = lfc(['backup', archive, '--passphrase', 'cli-test-pass']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(archive));
  assert.match(res.stdout, /backup: \d+ files/);

  const target = path.join(tmp, 'restore-target');
  const r2 = lfc(['restore', archive, '--data-dir', target, '--passphrase', 'cli-test-pass']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /restore: \d+ files/);
  assert.ok(fs.existsSync(path.join(target, 'buckets')));

  const r3 = lfc(['restore', archive, '--data-dir', path.join(tmp, 'bad'), '--passphrase', 'wrong']);
  assert.notEqual(r3.status, 0);
  assert.match(r3.stderr, /wrong passphrase|tampered/);
});
