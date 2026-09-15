// Configuration: file (~/.local-first-cloud/config.json) + env + overrides.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const APP_DIR_NAME = '.local-first-cloud';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 9100,
  region: 'us-east-1',
  maxBodyBytes: 100 * 1024 * 1024,
});

export function appDir() {
  return process.env.LFC_HOME || path.join(os.homedir(), APP_DIR_NAME);
}

export function configPath() {
  return process.env.LFC_CONFIG || path.join(appDir(), 'config.json');
}

export function defaultDataDir() {
  return process.env.LFC_DATA_DIR || path.join(appDir(), 'data');
}

export function defaultEndpoint(cfg = {}) {
  const host = cfg.host || DEFAULTS.host;
  const port = cfg.port || DEFAULTS.port;
  return `http://${host}:${port}`;
}

export function genKeys() {
  return {
    accessKeyId: 'LFC' + crypto.randomBytes(8).toString('hex').toUpperCase(),
    secretAccessKey: crypto.randomBytes(30).toString('hex'),
  };
}

function readFileConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Precedence: overrides > env > config file > defaults.
export function loadConfig(overrides = {}) {
  const fileCfg = readFileConfig(configPath());
  const env = {};
  const envMap = {
    LFC_DATA_DIR: 'dataDir',
    LFC_HOST: 'host',
    LFC_PORT: 'port',
    LFC_REGION: 'region',
    LFC_ENDPOINT: 'endpoint',
    LFC_ACCESS_KEY_ID: 'accessKeyId',
    LFC_SECRET_ACCESS_KEY: 'secretAccessKey',
    LFC_PASSPHRASE: 'passphrase',
  };
  for (const [e, k] of Object.entries(envMap)) {
    if (process.env[e] !== undefined && process.env[e] !== '') env[k] = process.env[e];
  }
  if (env.port !== undefined) env.port = Number(env.port);

  const cfg = { ...DEFAULTS, ...fileCfg, ...env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null) cfg[k] = v;
  }
  if (!cfg.dataDir) cfg.dataDir = defaultDataDir();
  if (process.env.LFC_DATA_DIR && overrides.dataDir === undefined) cfg.dataDir = process.env.LFC_DATA_DIR;
  if (!cfg.endpoint) cfg.endpoint = defaultEndpoint(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serializable = {};
  for (const k of ['dataDir', 'host', 'port', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey', 'maxBodyBytes']) {
    if (cfg[k] !== undefined) serializable[k] = cfg[k];
  }
  fs.writeFileSync(file, JSON.stringify(serializable, null, 2) + '\n', { mode: 0o600 });
  return file;
}

export function isAuthConfigured(cfg) {
  return Boolean(cfg.accessKeyId && cfg.secretAccessKey);
}
