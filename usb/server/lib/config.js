'use strict';
// Config loading, defaults, validation and atomic save.
//
// Layout on the USB stick:
//   <usb>/server/config.default.json   shipped defaults, never edited
//   <usb>/data/config.json             the live config, edited by the admin UI
//
// Every relative path in the config is resolved against the USB root so the
// stick works no matter which drive letter or mount point it lands on.

const fs = require('fs');
const path = require('path');

const USB_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULTS_FILE = path.join(USB_ROOT, 'server', 'config.default.json');
const DATA_DIR = path.join(USB_ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Recursive merge where the override wins for scalars and arrays, and
// unknown keys in the override are dropped. Dropping unknown keys keeps a
// hand-edited config.json from smuggling in fields the server never reads.
function mergeKnown(defaults, override) {
  const out = Array.isArray(defaults) ? defaults.slice() : {};
  for (const [key, defValue] of Object.entries(defaults)) {
    const ovValue = isPlainObject(override) ? override[key] : undefined;
    if (ovValue === undefined) {
      out[key] = isPlainObject(defValue) ? mergeKnown(defValue, {}) : defValue;
    } else if (isPlainObject(defValue) && isPlainObject(ovValue)) {
      out[key] = mergeKnown(defValue, ovValue);
    } else {
      out[key] = ovValue;
    }
  }
  return out;
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Strip a UTF-8 BOM: Notepad on Windows adds one and JSON.parse chokes.
  return JSON.parse(text.replace(/^﻿/, ''));
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Coerce every field into a sane range. A bad config should degrade to a
// working server, not crash the stick on boot in someone's cupboard.
function validate(cfg) {
  const problems = [];

  cfg.server.port = clampInt(cfg.server.port, 1, 65535, 8080);
  cfg.server.host = typeof cfg.server.host === 'string' && cfg.server.host ? cfg.server.host : '0.0.0.0';
  cfg.server.requestTimeoutMs = clampInt(cfg.server.requestTimeoutMs, 1000, 600000, 30000);
  cfg.server.maxUploadBytes = clampInt(cfg.server.maxUploadBytes, 1024, 2 * 1024 * 1024 * 1024, 50 * 1024 * 1024);
  cfg.server.compress = cfg.server.compress !== false;

  if (cfg.server.adminPort !== null && cfg.server.adminPort !== undefined && cfg.server.adminPort !== '') {
    cfg.server.adminPort = clampInt(cfg.server.adminPort, 1, 65535, null);
    if (cfg.server.adminPort === cfg.server.port) {
      problems.push('server.adminPort equals server.port; running the admin panel on the public port instead');
      cfg.server.adminPort = null;
    }
  } else {
    cfg.server.adminPort = null;
  }

  if (typeof cfg.admin.path !== 'string' || !/^\/[A-Za-z0-9._~/-]{1,64}$/.test(cfg.admin.path)) {
    problems.push('admin.path must look like "/__admin"; using the default');
    cfg.admin.path = '/__admin';
  }
  cfg.admin.path = cfg.admin.path.replace(/\/+$/, '') || '/__admin';
  cfg.admin.sessionHours = clampInt(cfg.admin.sessionHours, 1, 720, 12);

  cfg.security.loginMaxAttempts = clampInt(cfg.security.loginMaxAttempts, 1, 100, 5);
  cfg.security.loginLockoutMinutes = clampInt(cfg.security.loginLockoutMinutes, 1, 1440, 15);

  cfg.ddns.intervalMinutes = clampInt(cfg.ddns.intervalMinutes, 5, 1440, 15);
  cfg.logging.maxLogBytes = clampInt(cfg.logging.maxLogBytes, 64 * 1024, 512 * 1024 * 1024, 5 * 1024 * 1024);

  return problems;
}

// Turn the config's relative paths into absolute ones. Kept on a separate
// `paths` object so the saved config.json stays portable.
function withPaths(cfg) {
  const siteRoot = path.resolve(USB_ROOT, cfg.site.root || 'site');
  cfg.paths = {
    usbRoot: USB_ROOT,
    dataDir: DATA_DIR,
    siteRoot,
    adminDir: path.join(USB_ROOT, 'admin'),
    configFile: CONFIG_FILE,
    usersFile: path.join(DATA_DIR, 'users.json'),
    sessionsFile: path.join(DATA_DIR, 'sessions.json'),
    accessLog: path.join(DATA_DIR, 'access.log'),
    errorLog: path.join(DATA_DIR, 'error.log'),
  };
  return cfg;
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const defaults = readJson(DEFAULTS_FILE);

  let stored = {};
  let loadError = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      stored = readJson(CONFIG_FILE);
    } catch (err) {
      loadError = `data/config.json is not valid JSON (${err.message}); falling back to defaults`;
      // Keep the broken file so the operator can repair it by hand.
      try {
        fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.broken');
      } catch { /* best effort */ }
    }
  }

  const cfg = mergeKnown(defaults, stored);
  const problems = validate(cfg);
  if (loadError) problems.unshift(loadError);
  withPaths(cfg);
  cfg.problems = problems;
  return cfg;
}

// Write config.json atomically: write a temp file in the same directory,
// then rename over the target. A yanked USB stick mid-write then leaves the
// previous good config in place rather than a half-written one.
function save(cfg) {
  const serialisable = {};
  const defaults = readJson(DEFAULTS_FILE);
  for (const key of Object.keys(defaults)) serialisable[key] = cfg[key];

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.' + process.pid + '.tmp';
  const text = JSON.stringify(serialisable, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, CONFIG_FILE);
  return serialisable;
}

// Apply a partial update from the admin UI, validate it, and persist.
// Returns the reloaded config so the caller can swap it in wholesale.
function update(current, patch) {
  const defaults = readJson(DEFAULTS_FILE);
  const base = {};
  for (const key of Object.keys(defaults)) base[key] = current[key];
  const merged = mergeKnown(defaults, mergeKnown(base, patch));
  const problems = validate(merged);
  save(merged);
  withPaths(merged);
  merged.problems = problems;
  return merged;
}

module.exports = { load, save, update, USB_ROOT, DATA_DIR, CONFIG_FILE, mergeKnown };
