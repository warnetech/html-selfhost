'use strict';
// Small request/response helpers shared by the static server and the admin API.

const crypto = require('crypto');

// Read a request body with a hard byte ceiling. Resolves with a Buffer.
// Destroys the socket if the client keeps sending past the limit rather than
// buffering an unbounded upload from a stranger on the internet.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`);
      err.statusCode = 413;
      req.destroy();
      reject(err);
      return;
    }

    const chunks = [];
    let received = 0;
    let settled = false;

    const fail = (message, statusCode) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.statusCode = statusCode;
      req.destroy();
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        fail(`request body exceeds ${maxBytes} bytes`, 413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, received));
    });
    req.on('aborted', () => fail('client aborted the request', 400));
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    const e = new Error('request body is not valid JSON');
    e.statusCode = 400;
    throw e;
  }
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function serialiseCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Strict'}`);
  return parts.join('; ');
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function isPrivateAddress(ip) {
  if (!ip) return false;
  let addr = ip;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7); // IPv4-mapped IPv6
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (PRIVATE_V4.some((re) => re.test(addr))) return true;
  const lowered = addr.toLowerCase();
  // fc00::/7 unique-local and fe80::/10 link-local
  if (lowered.startsWith('fc') || lowered.startsWith('fd') || lowered.startsWith('fe8')) return true;
  return false;
}

// The peer address, or the left-most X-Forwarded-For entry when the config
// says we sit behind a reverse proxy we control. Never trust the header
// otherwise: anyone can set it, and it feeds the login throttle.
function clientIp(req, behindProxy) {
  if (behindProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || '';
}

function securityHeaders(res, cfg, { isHtml }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isHtml && cfg.security.contentSecurityPolicy) {
    res.setHeader('Content-Security-Policy', cfg.security.contentSecurityPolicy);
  }
  if (cfg.security.hsts) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
  return body.length;
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return body.length;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Constant-time-ish string compare for CSRF tokens.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

module.exports = {
  readBody, readJson, parseCookies, serialiseCookie, clientIp, isPrivateAddress,
  securityHeaders, sendJson, sendText, escapeHtml, safeEqual, formatBytes,
};
