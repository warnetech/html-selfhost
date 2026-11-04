'use strict';
// Console + file logging with size-based rotation.
//
// USB sticks are small and often FAT32, so logs rotate on size (one .1
// generation kept) rather than by date, and every write is best-effort:
// a full or write-protected stick must never take the web server down.

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOURS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

let useColour = process.stdout.isTTY && !process.env.NO_COLOR;
let minLevel = LEVELS[process.env.SHS_LOG_LEVEL] || LEVELS.info;
let accessLogFile = null;
let errorLogFile = null;
let maxBytes = 5 * 1024 * 1024;
let accessEnabled = true;
let writeFailureReported = false;

function configure({ dataDir, accessLog, errorLog, maxLogBytes, enableAccessLog }) {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  if (accessLog) accessLogFile = accessLog;
  if (errorLog) errorLogFile = errorLog;
  if (maxLogBytes) maxBytes = maxLogBytes;
  if (typeof enableAccessLog === 'boolean') accessEnabled = enableAccessLog;
}

function rotateIfNeeded(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // No file yet: nothing to rotate.
  }
  if (size < maxBytes) return;
  try {
    fs.renameSync(file, file + '.1');
  } catch {
    // Rotation failed (file locked on Windows, read-only stick). Truncate
    // instead so the log cannot grow without bound.
    try { fs.truncateSync(file, 0); } catch { /* give up quietly */ }
  }
}

function appendLine(file, line) {
  if (!file) return;
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    // Report a logging failure exactly once, to the console only, so a
    // read-only stick produces one warning instead of an infinite loop.
    if (!writeFailureReported) {
      writeFailureReported = true;
      process.stderr.write(`[log] cannot write to ${path.basename(file)}: ${err.message}\n`);
    }
  }
}

function emit(level, message, extra) {
  if (LEVELS[level] < minLevel) return;
  const stamp = new Date().toISOString();
  const suffix = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  const plain = `${stamp} [${level}] ${message}${suffix}`;

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(useColour ? `${COLOURS[level]}${plain}${RESET}\n` : plain + '\n');

  if (level === 'error' || level === 'warn') appendLine(errorLogFile, plain);
}

const log = {
  configure,
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
  setLevel(name) { if (LEVELS[name]) minLevel = LEVELS[name]; },

  // One line per request, Combined-Log-ish but tab-free and easy to parse.
  access({ ip, method, url, status, bytes, ms, userAgent, referer }) {
    if (!accessEnabled) return;
    const line = [
      new Date().toISOString(),
      ip || '-',
      method || '-',
      url || '-',
      status || 0,
      bytes || 0,
      `${ms || 0}ms`,
      JSON.stringify(referer || '-'),
      JSON.stringify((userAgent || '-').slice(0, 200)),
    ].join(' ');
    appendLine(accessLogFile, line);
  },

  // Tail the access log for the admin UI. Reads at most the last 512 KiB so
  // a large log cannot blow up memory.
  tail(file, lines = 200) {
    try {
      const stat = fs.statSync(file);
      const window = Math.min(stat.size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(window);
        fs.readSync(fd, buf, 0, window, stat.size - window);
        const all = buf.toString('utf8').split('\n').filter(Boolean);
        // A partial first line is likely when we seek into the middle.
        if (window < stat.size && all.length) all.shift();
        return all.slice(-lines);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  },
};

module.exports = log;
