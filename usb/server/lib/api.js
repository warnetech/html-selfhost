'use strict';
// The remote management surface: admin UI assets plus a small JSON API for
// editing the site, changing settings and reading logs.
//
// Every mutating endpoint requires both a valid session cookie and a
// matching CSRF token header, so a hostile page in another tab cannot drive
// the panel on the operator's behalf.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const mime = require('./mime');
const log = require('./log');
const configLib = require('./config');
const { resolveWithin, PathError, isInside } = require('./safepath');
const { checkPasswordStrength } = require('./auth');
const {
  readBody, readJson, parseCookies, serialiseCookie, clientIp, isPrivateAddress,
  sendJson, safeEqual, formatBytes,
} = require('./http');

const SESSION_COOKIE = 'shs_session';
const CSRF_HEADER = 'x-csrf-token';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_DEPTH = 12;
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

class ApiError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function requireString(value, field, { max = 1024 } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${field} is required`);
  }
  if (value.length > max) throw new ApiError(400, `${field} is too long`);
  return value;
}

// ---------------------------------------------------------------------------

function createAdminHandler(ctx) {
  const { auth, ddns, stats } = ctx;

  // cfg is read through a getter because PUT /api/config swaps the whole
  // object; capturing it once would leave handlers on a stale copy.
  const cfg = () => ctx.getConfig();

  function siteRoot() {
    return cfg().paths.siteRoot;
  }

  function resolveSitePath(input, { allowDotfiles = true } = {}) {
    try {
      return resolveWithin(siteRoot(), input || '', { allowDotfiles });
    } catch (err) {
      if (err instanceof PathError) throw new ApiError(400, err.message);
      throw err;
    }
  }

  // Re-check containment after following symlinks. resolveWithin only proves
  // the *string* is inside the root.
  async function assertRealInside(absolute) {
    try {
      const real = await fsp.realpath(absolute);
      const realRoot = await fsp.realpath(siteRoot());
      if (!isInside(realRoot, real)) throw new ApiError(400, 'path escapes the site folder');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.code === 'ENOENT') return; // Creating something new is fine.
      throw err;
    }
  }

  function sessionFor(req) {
    const cookies = parseCookies(req.headers.cookie);
    return auth.getSession(cookies[SESSION_COOKIE]);
  }

  function requireSession(req) {
    const session = sessionFor(req);
    if (!session) throw new ApiError(401, 'not signed in');
    return session;
  }

  // Double-submit CSRF plus an Origin check. SameSite=Strict already blocks
  // most of this, but old browsers and non-browser clients do not honour it.
  function requireCsrf(req, session) {
    const supplied = req.headers[CSRF_HEADER];
    if (!safeEqual(supplied, session.csrf)) {
      throw new ApiError(403, 'missing or invalid CSRF token');
    }
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw new ApiError(403, 'malformed Origin header');
      }
      if (!host || originHost !== host) {
        throw new ApiError(403, 'cross-origin request rejected');
      }
    }
  }

  function guardLanOnly(req) {
    if (!cfg().admin.lanOnly) return;
    const ip = clientIp(req, cfg().server.behindProxy);
    if (!isPrivateAddress(ip)) {
      throw new ApiError(403, 'the admin panel is restricted to local network clients');
    }
  }

  // ---- admin UI assets ----------------------------------------------------

  const UI_FILES = new Set(['index.html', 'app.css', 'app.js', 'favicon.svg']);

  async function serveUiAsset(res, name) {
    const file = path.join(cfg().paths.adminDir, name);
    let body;
    try {
      body = await fsp.readFile(file);
    } catch {
      throw new ApiError(404, `admin asset ${name} is missing from the USB stick`);
    }
    res.writeHead(200, {
      'Content-Type': mime.lookup(name),
      'Content-Length': body.length,
      // The panel must never be cached: a stale app.js against a new API is
      // far more confusing than a re-download of a few kilobytes.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(body);
    return body.length;
  }

  // ---- endpoints ----------------------------------------------------------

  async function handleLogin(req, res) {
    const ip = clientIp(req, cfg().server.behindProxy);
    const remaining = auth.lockoutRemainingMs(ip);
    if (remaining > 0) {
      throw new ApiError(429, `too many failed attempts; try again in ${Math.ceil(remaining / 60000)} minute(s)`);
    }

    const body = await readJson(req, 16 * 1024);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) throw new ApiError(400, 'username and password are required');

    const user = auth.verify(username, password);
    if (!user) {
      const entry = auth.recordFailure(ip);
      log.warn('failed admin login', { ip, username: username.slice(0, 32), fails: entry.fails });
      // Deliberately vague: do not reveal whether the account exists.
      throw new ApiError(401, 'incorrect username or password');
    }

    auth.recordSuccess(ip);
    const session = auth.createSession(user, { ip, userAgent: req.headers['user-agent'] });
    log.info('admin signed in', { ip, username: user.username });

    const secure = cfg().security.forceHttps || cfg().security.hsts;
    return sendJson(res, 200, {
      ok: true,
      username: user.username,
      csrf: session.csrf,
      mustChangePassword: !!user.mustChangePassword,
      expiresAt: session.expiresAt,
    }, {
      'Set-Cookie': serialiseCookie(SESSION_COOKIE, session.token, {
        maxAge: cfg().admin.sessionHours * 3600,
        secure,
        sameSite: 'Strict',
        path: cfg().admin.path,
      }),
    });
  }

  function handleLogout(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    auth.destroySession(cookies[SESSION_COOKIE]);
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': serialiseCookie(SESSION_COOKIE, '', { maxAge: 0, path: cfg().admin.path }),
    });
  }

  function handleSession(req, res) {
    const session = sessionFor(req);
    if (!session) return sendJson(res, 200, { signedIn: false });
    const user = auth.listUsers().find((u) => u.username === session.username);
    return sendJson(res, 200, {
      signedIn: true,
      username: session.username,
      csrf: session.csrf,
      expiresAt: session.expiresAt,
      mustChangePassword: !!(user && user.mustChangePassword),
    });
  }

  async function handleStatus(req, res) {
    const c = cfg();
    let disk = null;
    try {
      // statfs landed in Node 18.15; treat it as optional.
      const fsStat = await fsp.statfs(c.paths.usbRoot);
      disk = {
        freeBytes: fsStat.bavail * fsStat.bsize,
        totalBytes: fsStat.blocks * fsStat.bsize,
        free: formatBytes(fsStat.bavail * fsStat.bsize),
        total: formatBytes(fsStat.blocks * fsStat.bsize),
      };
    } catch { /* not available on this platform */ }

    let siteBytes = 0;
    let siteFiles = 0;
    try {
      const walked = await walkTree(siteRoot(), '', 0, { files: 0 });
      siteFiles = walked.fileCount;
      siteBytes = walked.byteCount;
    } catch { /* unreadable site folder is reported elsewhere */ }

    return sendJson(res, 200, {
      ok: true,
      version: ctx.version,
      startedAt: stats.startedAt,
      uptimeSeconds: Math.floor((Date.now() - stats.startedAtMs) / 1000),
      requests: stats.requests,
      bytesServed: stats.bytesServed,
      bytesServedHuman: formatBytes(stats.bytesServed),
      errors: stats.errors,
      site: { files: siteFiles, bytes: siteBytes, human: formatBytes(siteBytes), root: c.paths.siteRoot },
      disk,
      host: {
        hostname: os.hostname(),
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        lanAddresses: lanAddresses(),
        loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
        memoryFree: formatBytes(os.freemem()),
        memoryTotal: formatBytes(os.totalmem()),
      },
      server: { port: c.server.port, adminPort: c.server.adminPort, adminPath: c.admin.path },
      ddns: ddns.status(),
      problems: c.problems || [],
    });
  }

  // Recursively measure/collect the site folder, with hard caps so a
  // pathological tree cannot hang the panel.
  async function walkTree(absRoot, relative, depth, budget) {
    const result = { entries: [], fileCount: 0, byteCount: 0, truncated: false };
    if (depth > MAX_TREE_DEPTH) { result.truncated = true; return result; }

    let dirents;
    try {
      dirents = await fsp.readdir(path.join(absRoot, relative), { withFileTypes: true });
    } catch {
      return result;
    }
    dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

    for (const dirent of dirents) {
      if (budget.files >= MAX_TREE_ENTRIES) { result.truncated = true; break; }
      // Skip symlinks entirely rather than trying to decide where they point.
      if (dirent.isSymbolicLink()) continue;
      const childRel = relative ? `${relative}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        budget.files++;
        const child = await walkTree(absRoot, childRel, depth + 1, budget);
        result.fileCount += child.fileCount;
        result.byteCount += child.byteCount;
        result.truncated = result.truncated || child.truncated;
        result.entries.push({ name: dirent.name, path: childRel, type: 'dir', children: child.entries });
      } else if (dirent.isFile()) {
        budget.files++;
        let size = 0;
        let mtime = 0;
        try {
          const st = await fsp.stat(path.join(absRoot, childRel));
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* vanished mid-walk */ }
        result.fileCount++;
        result.byteCount += size;
        result.entries.push({
          name: dirent.name, path: childRel, type: 'file',
          size, sizeHuman: formatBytes(size), mtime,
          editable: mime.isEditable(dirent.name) && size <= MAX_EDITABLE_BYTES,
        });
      }
    }
    return result;
  }

  async function handleTree(req, res) {
    await fsp.mkdir(siteRoot(), { recursive: true });
    const tree = await walkTree(siteRoot(), '', 0, { files: 0 });
    return sendJson(res, 200, {
      ok: true,
      root: siteRoot(),
      entries: tree.entries,
      fileCount: tree.fileCount,
      totalBytes: tree.byteCount,
      truncated: tree.truncated,
    });
  }

  async function handleReadFile(req, res, query) {
    const { relative, absolute } = resolveSitePath(query.get('path'));
    if (!relative) throw new ApiError(400, 'path is required');
    await assertRealInside(absolute);

    let stat;
    try {
      stat = await fsp.stat(absolute);
    } catch {
      throw new ApiError(404, 'file not found');
    }
    if (!stat.isFile()) throw new ApiError(400, 'that path is a folder, not a file');
    if (!mime.isEditable(relative)) {
      throw new ApiError(415, 'that file type cannot be opened in the text editor; download it instead');
    }
    if (stat.size > MAX_EDITABLE_BYTES) {
      throw new ApiError(413, `file is larger than ${formatBytes(MAX_EDITABLE_BYTES)}; edit it offline`);
    }

    const content = await fsp.readFile(absolute, 'utf8');
    return sendJson(res, 200, {
      ok: true, path: relative, content, size: stat.size, mtime: stat.mtimeMs,
    });
  }

  async function handleWriteFile(req, res, query) {
    const { relative, absolute } = resolveSitePath(query.get('path'));
    if (!relative) throw new ApiError(400, 'path is required');
    if (!mime.isEditable(relative)) {
      throw new ApiError(415, 'that file type cannot be saved from the text editor');
    }
    await assertRealInside(absolute);

    const body = await readJson(req, MAX_JSON_BYTES);
    if (typeof body.content !== 'string') throw new ApiError(400, 'content must be a string');

    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    // Write to a temp file and rename, so a browser that dies mid-save
    // cannot leave a truncated index.html serving to the public.
    const tmp = `${absolute}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body.content, 'utf8');
    await fsp.rename(tmp, absolute);

    const stat = await fsp.stat(absolute);
    log.info('site file saved', { path: relative, bytes: stat.size });
    return sendJson(res, 200, { ok: true, path: relative, size: stat.size, mtime: stat.mtimeMs });
  }

  async function handleUpload(req, res, query) {
    const { relative, absolute } = resolveSitePath(query.get('path'));
    if (!relative) throw new ApiError(400, 'path is required');
    await assertRealInside(absolute);

    const buf = await readBody(req, cfg().server.maxUploadBytes);
    if (buf.length === 0) throw new ApiError(400, 'uploaded file is empty');

    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    const tmp = `${absolute}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, absolute);

    log.info('file uploaded', { path: relative, bytes: buf.length });
    return sendJson(res, 200, { ok: true, path: relative, size: buf.length, sizeHuman: formatBytes(buf.length) });
  }

  async function handleDownload(req, res, query) {
    const { relative, absolute } = resolveSitePath(query.get('path'));
    if (!relative) throw new ApiError(400, 'path is required');
    await assertRealInside(absolute);

    let stat;
    try {
      stat = await fsp.stat(absolute);
    } catch {
      throw new ApiError(404, 'file not found');
    }
    if (!stat.isFile()) throw new ApiError(400, 'that path is a folder');

    const filename = path.basename(relative).replace(/["\\]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(absolute);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
    return stat.size;
  }

  async function handleMkdir(req, res) {
    const body = await readJson(req, 16 * 1024);
    const { relative, absolute } = resolveSitePath(requireString(body.path, 'path'));
    if (!relative) throw new ApiError(400, 'path is required');
    await fsp.mkdir(absolute, { recursive: true });
    return sendJson(res, 200, { ok: true, path: relative });
  }

  async function handleRename(req, res) {
    const body = await readJson(req, 16 * 1024);
    const from = resolveSitePath(requireString(body.from, 'from'));
    const to = resolveSitePath(requireString(body.to, 'to'));
    if (!from.relative || !to.relative) throw new ApiError(400, 'from and to are required');
    if (from.relative === to.relative) return sendJson(res, 200, { ok: true, path: to.relative });

    await assertRealInside(from.absolute);
    try {
      await fsp.access(to.absolute);
      throw new ApiError(409, `"${to.relative}" already exists`);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // ENOENT is what we want: the destination is free.
    }

    await fsp.mkdir(path.dirname(to.absolute), { recursive: true });
    try {
      await fsp.rename(from.absolute, to.absolute);
    } catch (err) {
      if (err.code === 'ENOENT') throw new ApiError(404, `"${from.relative}" not found`);
      throw err;
    }
    log.info('site entry renamed', { from: from.relative, to: to.relative });
    return sendJson(res, 200, { ok: true, path: to.relative });
  }

  async function handleDelete(req, res) {
    const body = await readJson(req, 16 * 1024);
    const { relative, absolute } = resolveSitePath(requireString(body.path, 'path'));
    if (!relative) throw new ApiError(400, 'refusing to delete the site root');
    await assertRealInside(absolute);

    let stat;
    try {
      stat = await fsp.lstat(absolute);
    } catch {
      throw new ApiError(404, 'not found');
    }

    if (stat.isDirectory()) {
      // Recursive delete is destructive enough to demand an explicit flag
      // from the caller rather than inferring intent.
      if (body.recursive !== true) {
        const contents = await fsp.readdir(absolute);
        if (contents.length > 0) {
          throw new ApiError(409, `"${relative}" is not empty; confirm a recursive delete`);
        }
      }
      await fsp.rm(absolute, { recursive: true, force: true });
    } else {
      await fsp.unlink(absolute);
    }
    log.warn('site entry deleted', { path: relative, dir: stat.isDirectory() });
    return sendJson(res, 200, { ok: true, path: relative });
  }

  function redactConfig(c) {
    // Never echo secrets back to the browser. The UI shows a placeholder and
    // only sends a value when the operator actually types a new one.
    const clone = JSON.parse(JSON.stringify({
      site: c.site, server: c.server, admin: c.admin, security: c.security,
      ddns: c.ddns, logging: c.logging,
    }));
    const mask = (value) => (value ? '••••••••' : '');
    clone.ddns.duckdns.token = mask(clone.ddns.duckdns.token);
    clone.ddns.cloudflare.apiToken = mask(clone.ddns.cloudflare.apiToken);
    if (clone.ddns.generic.url) {
      clone.ddns.generic.url = clone.ddns.generic.url.replace(/([?&](?:token|password|key)=)[^&]*/gi, '$1••••••••');
    }
    return clone;
  }

  function handleGetConfig(req, res) {
    return sendJson(res, 200, {
      ok: true,
      config: redactConfig(cfg()),
      defaultsFile: 'server/config.default.json',
      configFile: cfg().paths.configFile,
    });
  }

  async function handlePutConfig(req, res) {
    const patch = await readJson(req, 256 * 1024);
    if (typeof patch !== 'object' || patch === null) throw new ApiError(400, 'config must be an object');

    // A masked secret means "leave it alone"; drop it from the patch so the
    // stored token is not overwritten with bullet characters.
    const stripMasked = (obj, key) => {
      if (obj && typeof obj[key] === 'string' && /^•+$/.test(obj[key])) delete obj[key];
    };
    if (patch.ddns) {
      stripMasked(patch.ddns.duckdns, 'token');
      stripMasked(patch.ddns.cloudflare, 'apiToken');
      if (patch.ddns.generic && typeof patch.ddns.generic.url === 'string' && patch.ddns.generic.url.includes('•')) {
        delete patch.ddns.generic.url;
      }
    }
    // Refuse to let the panel lock itself out of its own process: changing
    // the listening port needs a restart, so make that explicit.
    const before = cfg();
    const portChanged = patch.server && patch.server.port !== undefined &&
      Number(patch.server.port) !== before.server.port;
    const adminPortChanged = patch.server && patch.server.adminPort !== undefined &&
      (patch.server.adminPort || null) !== before.server.adminPort;

    const next = configLib.update(before, patch);
    ctx.setConfig(next);

    log.configure({
      maxLogBytes: next.logging.maxLogBytes,
      enableAccessLog: next.logging.accessLog,
    });
    ddns.cfg = next;
    ddns.start();

    log.info('configuration updated');
    return sendJson(res, 200, {
      ok: true,
      config: redactConfig(next),
      restartRequired: portChanged || adminPortChanged,
      problems: next.problems,
    });
  }

  async function handlePassword(req, res, query, session) {
    const body = await readJson(req, 16 * 1024);
    const current = String(body.current || '');
    const next = String(body.next || '');
    const weakness = checkPasswordStrength(next);
    if (weakness) throw new ApiError(400, weakness);

    const result = auth.changePassword(session.username, current, next);
    if (!result.ok) throw new ApiError(400, result.error);

    log.info('admin password changed', { username: session.username });
    // Every session died with the password change, including this one.
    return sendJson(res, 200, { ok: true, signedOut: true }, {
      'Set-Cookie': serialiseCookie(SESSION_COOKIE, '', { maxAge: 0, path: cfg().admin.path }),
    });
  }

  function handleLogs(req, res, query) {
    const which = query.get('which') === 'error' ? 'error' : 'access';
    const lines = Math.min(1000, Math.max(1, Number.parseInt(query.get('lines') || '200', 10) || 200));
    const file = which === 'error' ? cfg().paths.errorLog : cfg().paths.accessLog;
    return sendJson(res, 200, { ok: true, which, lines: log.tail(file, lines) });
  }

  async function handleDdnsUpdate(req, res) {
    const result = await ddns.runOnce({ force: true });
    if (!result.ok) throw new ApiError(502, result.error);
    return sendJson(res, 200, { ok: true, ...result, status: ddns.status() });
  }

  // ---- routing ------------------------------------------------------------

  const ROUTES = [
    // [method, path, handler, { auth, csrf }]
    ['POST', '/api/login', handleLogin, { auth: false, csrf: false }],
    ['POST', '/api/logout', handleLogout, { auth: false, csrf: false }],
    ['GET', '/api/session', handleSession, { auth: false }],
    ['GET', '/api/status', handleStatus, { auth: true }],
    ['GET', '/api/tree', handleTree, { auth: true }],
    ['GET', '/api/file', handleReadFile, { auth: true }],
    ['PUT', '/api/file', handleWriteFile, { auth: true, csrf: true }],
    ['POST', '/api/upload', handleUpload, { auth: true, csrf: true }],
    ['GET', '/api/download', handleDownload, { auth: true }],
    ['POST', '/api/mkdir', handleMkdir, { auth: true, csrf: true }],
    ['POST', '/api/rename', handleRename, { auth: true, csrf: true }],
    ['POST', '/api/delete', handleDelete, { auth: true, csrf: true }],
    ['GET', '/api/config', handleGetConfig, { auth: true }],
    ['PUT', '/api/config', handlePutConfig, { auth: true, csrf: true }],
    ['POST', '/api/password', handlePassword, { auth: true, csrf: true }],
    ['GET', '/api/logs', handleLogs, { auth: true }],
    ['POST', '/api/ddns', handleDdnsUpdate, { auth: true, csrf: true }],
  ];

  // Returns bytes written, or throws ApiError.
  async function handle(req, res, subPath, query) {
    guardLanOnly(req);

    if (!cfg().admin.enabled) throw new ApiError(404, 'the admin panel is disabled');

    // UI assets
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (subPath === '' || subPath === '/') return serveUiAsset(res, 'index.html');
      const asset = subPath.replace(/^\//, '');
      if (UI_FILES.has(asset)) return serveUiAsset(res, asset);
    }

    const route = ROUTES.find(([method, routePath]) => routePath === subPath && method === req.method);
    if (!route) {
      const pathExists = ROUTES.some(([, routePath]) => routePath === subPath);
      if (pathExists) throw new ApiError(405, `${req.method} is not allowed on ${subPath}`);
      throw new ApiError(404, 'no such admin endpoint');
    }

    const [, , handler, opts] = route;
    let session = null;
    if (opts.auth) session = requireSession(req);
    if (opts.csrf) requireCsrf(req, session || requireSession(req));

    return handler(req, res, query, session);
  }

  return { handle, ApiError, SESSION_COOKIE };
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ interface: name, address: addr.address });
    }
  }
  return out;
}

module.exports = { createAdminHandler, ApiError, lanAddresses, SESSION_COOKIE };
