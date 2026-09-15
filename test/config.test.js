import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, saveConfig, configPath, genKeys, isAuthConfigured, DEFAULTS } from '../lib/config.js';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-cfg-'));
  const saved = { LFC_HOME: process.env.LFC_HOME, LFC_CONFIG: process.env.LFC_CONFIG, LFC_DATA_DIR: process.env.LFC_DATA_DIR, LFC_PORT: process.env.LFC_PORT, LFC_ACCESS_KEY_ID: process.env.LFC_ACCESS_KEY_ID };
  process.env.LFC_HOME = dir;
  delete process.env.LFC_CONFIG;
  delete process.env.LFC_DATA_DIR;
  delete process.env.LFC_PORT;
  delete process.env.LFC_ACCESS_KEY_ID;
  try {
    return fn(dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults applied when nothing configured', () => {
  withTempHome((dir) => {
    const cfg = loadConfig();
    assert.equal(cfg.host, DEFAULTS.host);
    assert.equal(cfg.port, DEFAULTS.port);
    assert.equal(cfg.region, DEFAULTS.region);
    assert.equal(cfg.dataDir, path.join(dir, 'data'));
    assert.equal(cfg.endpoint, 'http://127.0.0.1:9100');
    assert.equal(isAuthConfigured(cfg), false);
  });
});

test('saveConfig/loadConfig round-trip', () => {
  withTempHome(() => {
    const keys = genKeys();
    assert.match(keys.accessKeyId, /^LFC[0-9A-F]{16}$/);
    assert.equal(keys.secretAccessKey.length, 60);
    saveConfig({ dataDir: '/tmp/x', port: 9999, ...keys });
    const cfg = loadConfig();
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.accessKeyId, keys.accessKeyId);
    assert.equal(cfg.secretAccessKey, keys.secretAccessKey);
    assert.equal(isAuthConfigured(cfg), true);
  });
});

test('env overrides file, flags override env', () => {
  withTempHome(() => {
    saveConfig({ port: 9111 });
    process.env.LFC_PORT = '9222';
    let cfg = loadConfig();
    assert.equal(cfg.port, 9222);
    cfg = loadConfig({ port: 9333 });
    assert.equal(cfg.port, 9333);
    delete process.env.LFC_PORT;
  });
});

test('config file written with 0600 mode', () => {
  withTempHome(() => {
    saveConfig({ port: 9100 });
    const st = fs.statSync(configPath());
    if (process.platform !== 'win32') {
      assert.equal(st.mode & 0o777, 0o600);
    }
  });
});
