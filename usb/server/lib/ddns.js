'use strict';
// Dynamic DNS updater.
//
// Telstra hands residential NBN services a real public IPv4 address, but a
// dynamic one — it changes when the modem reconnects. Without DDNS your
// domain points at last week's address after every outage.

const https = require('https');
const { URL } = require('url');
const log = require('./log');

const IP_LOOKUP_URLS = [
  'https://api.ipify.org',
  'https://checkip.amazonaws.com',
  'https://ipv4.icanhazip.com',
];

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function request(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      reject(new Error(`invalid URL: ${urlString}`));
      return;
    }
    if (url.protocol !== 'https:') {
      // Credentials travel in these requests; plain HTTP would leak them.
      reject(new Error('DDNS endpoints must use https://'));
      return;
    }

    const req = https.request(
      url,
      { method, headers: { 'User-Agent': 'self-host-starter/1.0', ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 256 * 1024) { req.destroy(new Error('response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function detectPublicIp() {
  const errors = [];
  for (const url of IP_LOOKUP_URLS) {
    try {
      const { status, body } = await request(url, { timeoutMs: 8000 });
      const candidate = body.trim();
      if (status === 200 && IPV4_RE.test(candidate)) return candidate;
      errors.push(`${url} -> ${status} ${candidate.slice(0, 40)}`);
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }
  throw new Error(`could not determine public IP (${errors.join('; ')})`);
}

async function updateDuckDns(settings, ip) {
  const domain = String(settings.domain || '').replace(/\.duckdns\.org$/i, '').trim();
  if (!domain || !settings.token) throw new Error('duckdns.domain and duckdns.token are required');
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}` +
    `&token=${encodeURIComponent(settings.token)}&ip=${encodeURIComponent(ip)}`;
  const { status, body } = await request(url);
  if (status !== 200 || !body.startsWith('OK')) {
    throw new Error(`DuckDNS rejected the update (HTTP ${status}: ${body.trim().slice(0, 80)})`);
  }
  return `${domain}.duckdns.org -> ${ip}`;
}

async function updateCloudflare(settings, ip) {
  const { apiToken, zoneId, recordName } = settings;
  if (!apiToken || !zoneId || !recordName) {
    throw new Error('cloudflare.apiToken, cloudflare.zoneId and cloudflare.recordName are required');
  }
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`;

  const listed = await request(`${base}?type=A&name=${encodeURIComponent(recordName)}`, { headers });
  let parsed;
  try {
    parsed = JSON.parse(listed.body);
  } catch {
    throw new Error(`Cloudflare returned a non-JSON response (HTTP ${listed.status})`);
  }
  if (!parsed.success) {
    throw new Error(`Cloudflare list failed: ${(parsed.errors || []).map((e) => e.message).join(', ')}`);
  }

  const payload = JSON.stringify({
    type: 'A', name: recordName, content: ip, ttl: 120, proxied: !!settings.proxied,
  });

  const existing = (parsed.result || [])[0];
  const result = existing
    ? await request(`${base}/${existing.id}`, { method: 'PUT', headers, body: payload })
    : await request(base, { method: 'POST', headers, body: payload });

  let out;
  try {
    out = JSON.parse(result.body);
  } catch {
    throw new Error(`Cloudflare returned a non-JSON response (HTTP ${result.status})`);
  }
  if (!out.success) {
    throw new Error(`Cloudflare update failed: ${(out.errors || []).map((e) => e.message).join(', ')}`);
  }
  return `${recordName} -> ${ip}${existing ? '' : ' (record created)'}`;
}

async function updateGeneric(settings, ip) {
  if (!settings.url) throw new Error('generic.url is required');
  // Most no-ip / dynu / afraid.org style endpoints take the address in the
  // query string; {ip} marks where it goes.
  const url = settings.url.includes('{ip}')
    ? settings.url.replace('{ip}', encodeURIComponent(ip))
    : settings.url;
  const { status, body } = await request(url);
  if (status < 200 || status >= 300) {
    throw new Error(`DDNS endpoint returned HTTP ${status}: ${body.trim().slice(0, 80)}`);
  }
  return `updated via generic endpoint -> ${ip} (${body.trim().slice(0, 60)})`;
}

const PROVIDERS = {
  duckdns: updateDuckDns,
  cloudflare: updateCloudflare,
  generic: updateGeneric,
};

class DdnsUpdater {
  constructor(cfg) {
    this.cfg = cfg;
    this.timer = null;
    this.lastIp = null;
    this.lastResult = null;
    this.lastRunAt = null;
    this.lastError = null;
  }

  status() {
    return {
      enabled: !!this.cfg.ddns.enabled,
      provider: this.cfg.ddns.provider,
      lastIp: this.lastIp,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      intervalMinutes: this.cfg.ddns.intervalMinutes,
    };
  }

  // force=true skips the "IP has not changed" shortcut, for the admin
  // panel's Update now button.
  async runOnce({ force = false } = {}) {
    const ddns = this.cfg.ddns;
    this.lastRunAt = new Date().toISOString();

    const provider = PROVIDERS[ddns.provider];
    if (!provider) {
      this.lastError = `unknown DDNS provider "${ddns.provider}"`;
      return { ok: false, error: this.lastError };
    }

    try {
      const ip = await detectPublicIp();
      if (!force && ip === this.lastIp) {
        this.lastError = null;
        this.lastResult = `no change (${ip})`;
        return { ok: true, changed: false, ip, message: this.lastResult };
      }
      const message = await provider(ddns[ddns.provider] || {}, ip);
      this.lastIp = ip;
      this.lastResult = message;
      this.lastError = null;
      log.info('ddns updated', message);
      return { ok: true, changed: true, ip, message };
    } catch (err) {
      this.lastError = err.message;
      log.warn('ddns update failed', err.message);
      return { ok: false, error: err.message };
    }
  }

  start() {
    this.stop();
    if (!this.cfg.ddns.enabled) return;
    const intervalMs = this.cfg.ddns.intervalMinutes * 60 * 1000;
    // Kick off shortly after boot rather than immediately: the modem may
    // still be negotiating its WAN address when the machine starts up.
    setTimeout(() => this.runOnce().catch(() => {}), 10_000).unref?.();
    this.timer = setInterval(() => this.runOnce().catch(() => {}), intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(`ddns enabled (${this.cfg.ddns.provider}, every ${this.cfg.ddns.intervalMinutes} min)`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { DdnsUpdater, detectPublicIp, PROVIDERS };
