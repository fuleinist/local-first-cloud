import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../lib/store.js';
import { backup, restore } from '../lib/backup.js';

let tmp;
let dataDir;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-backup-'));
  dataDir = path.join(tmp, 'data');
  const store = new Store(dataDir);
  await store.init();
  await store.createBucket('vault');
  await store.putObject('vault', 'notes/secret.txt', Buffer.from('top secret bytes'));
  await store.putObject('vault', 'binary.bin', Buffer.from([0, 1, 2, 253, 254, 255]));
  await store.createBucket('empty-bucket');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('backup produces LFCK archive', async () => {
  const out = path.join(tmp, 'vault.lfcb');
  const res = await backup({ dataDir, outFile: out, passphrase: 'correct-horse' });
  assert.ok(res.entries >= 4, `expected >=4 entries, got ${res.entries}`);
  assert.ok(res.bytes > 0);
  const head = Buffer.alloc(4);
  const fd = fs.openSync(out, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  assert.equal(head.toString('ascii'), 'LFCK');
});

test('restore round-trips byte-identically', async () => {
  const out = path.join(tmp, 'vault.lfcb');
  const target = path.join(tmp, 'restored');
  const res = await restore({ file: out, dataDir: target, passphrase: 'correct-horse' });
  assert.ok(res.entries >= 4);

  const store = new Store(target);
  const a = await store.getObjectBuffer('vault', 'notes/secret.txt');
  assert.equal(a.toString(), 'top secret bytes');
  const b = await store.getObjectBuffer('vault', 'binary.bin');
  assert.deepEqual(b, Buffer.from([0, 1, 2, 253, 254, 255]));
  const m = await store.getMeta('vault', 'notes/secret.txt');
  assert.equal(m.contentType, 'application/octet-stream');
  await store.headBucket('empty-bucket');
});

test('wrong passphrase fails with nothing restored', async () => {
  const out = path.join(tmp, 'vault.lfcb');
  const target = path.join(tmp, 'bad-restore');
  await assert.rejects(
    () => restore({ file: out, dataDir: target, passphrase: 'wrong-horse' }),
    /wrong passphrase or tampered archive/
  );
  // staging cleaned up, target not created
  assert.equal(fs.existsSync(target), false);
  const leftovers = fs.readdirSync(tmp).filter((n) => n.includes('.lfc-restore-'));
  assert.deepEqual(leftovers, []);
});

test('tampered archive fails authentication', async () => {
  const out = path.join(tmp, 'tampered.lfcb');
  fs.copyFileSync(path.join(tmp, 'vault.lfcb'), out);
  const buf = fs.readFileSync(out);
  // flip a byte deep in the ciphertext region (after header)
  buf[buf.length - 40] ^= 0xff;
  fs.writeFileSync(out, buf);
  const target = path.join(tmp, 'tampered-restore');
  await assert.rejects(() => restore({ file: out, dataDir: target, passphrase: 'correct-horse' }));
  assert.equal(fs.existsSync(target), false);
});

test('restore into non-empty dir refuses', async () => {
  const out = path.join(tmp, 'vault.lfcb');
  await assert.rejects(
    () => restore({ file: out, dataDir: tmp, passphrase: 'correct-horse' }),
    /non-empty/
  );
});

test('missing passphrase rejected early', async () => {
  await assert.rejects(() => backup({ dataDir, outFile: path.join(tmp, 'x.lfcb') }), /passphrase is required/);
  await assert.rejects(() => restore({ file: path.join(tmp, 'vault.lfcb'), dataDir: path.join(tmp, 'y') }), /passphrase is required/);
});

test('not-an-archive rejected', async () => {
  const junk = path.join(tmp, 'junk.lfcb');
  fs.writeFileSync(junk, 'this is not an archive at all');
  await assert.rejects(() => restore({ file: junk, dataDir: path.join(tmp, 'z'), passphrase: 'x' }), /bad magic/);
});
