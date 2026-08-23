#!/usr/bin/env node
'use strict';
// Self-Host Starter — a zero-dependency web server that runs from a USB stick.
//
//   node server/server.js            start on the configured port
//   node server/server.js --port 80  override the port for this run
//   node server/server.js --check    validate config and exit
//
// Everything it needs is in the Node standard library, so the stick works on
// any machine with Node installed and no network access to npm.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const configLib = require('./lib/config');
const log = require('./lib/log');
const staticServer = require('./lib/static');
const { Auth } = require('./lib/auth');
const { DdnsUpdater } = require('./lib/ddns');
const { createAdminHandler, lanAddresses } = require('./lib/api');
const { clientIp, sendJson, sendText } = require('./lib/http');

const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const args = { port: null, host: null, check: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') args.port = Number.parseInt(argv[++i], 10);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--check') args.check = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg.startsWith('--port=')) args.port = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--host=')) args.host = arg.slice(7);
  }
  return args;
}

const HELP = `Self-Host Starter v${VERSION}

Usage: node server/server.js [options]

  -p, --port <n>   listen on this port for this run (overrides config)
      --host <ip>  bind to this address (default 0.0.0.0, all interfaces)
      --check      load and validate the config, then exit
  -v, --version    print the version
  -h, --help       show this help

Settings live in data/config.json and can be edited from the admin panel.
`;

// ---------------------------------------------------------------------------
// Boot

function boot() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return null; }
  if (args.version) { process.stdout.write(VERSION + '\n'); return null; }

  let cfg;
  try {
    cfg = configLib.load();
  } catch (err) {
    process.stderr.write(`\nFATAL: could not load configuration\n  ${err.message}\n\n`);
    process.exit(1);
  }

  if (Number.isFinite(args.port)) cfg.server.port = args.port;
  if (args.host) cfg.server.host = args.host;

  log.configure({
    dataDir: cfg.paths.dataDir,
    accessLog: cfg.paths.accessLog,
    errorLog: cfg.paths.errorLog,
    maxLogBytes: cfg.logging.maxLogBytes,
    enableAccessLog: cfg.logging.accessLog,
  });

  for (const problem of cfg.problems) log.warn('config: ' + problem);

  // The site folder is the one thing we cannot invent a default for.
  if (!fs.existsSync(cfg.paths.siteRoot)) {
    log.warn(`site folder ${cfg.paths.siteRoot} does not exist; creating it`);
    fs.mkdirSync(cfg.paths.siteRoot, { recursive: true });
  }

  const auth = new Auth(cfg);
  try {
    auth.load();
  } catch (err) {
    process.stderr.write(`\nFATAL: ${err.message}\n\n`);
    process.exit(1);
  }

  if (args.check) {
    process.stdout.write('Configuration OK\n');
    process.stdout.write(`  site root : ${cfg.paths.siteRoot}\n`);
    process.stdout.write(`  port      : ${cfg.server.port}\n`);
    process.stdout.write(`  admin path: ${cfg.admin.path}\n`);
    process.stdout.write(`  users     : ${auth.listUsers().map((u) => u.username).join(', ')}\n`);
    if (cfg.problems.length) {
      process.stdout.write('  warnings  :\n');
      for (const p of cfg.problems) process.stdout.write(`    - ${p}\n`);
    }
    return null;
  }

  return { cfg, auth };
}

// ---------------------------------------------------------------------------

function start(cfg, auth) {
  const stats = {
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    requests: 0,
    bytesServed: 0,
    errors: 0,
  };

  const ddns = new DdnsUpdater(cfg);

  // cfg is mutable state: the admin panel can replace it wholesale, so the
  // handlers read it through this box rather than closing over the object.
  const state = { cfg };
  const ctx = {
    version: VERSION,
    auth,
    ddns,
    stats,
    getConfig: () => state.cfg,
    setConfig: (next) => { state.cfg = next; },
  };
  const admin = createAdminHandler(ctx);

  // -- request handling -----------------------------------------------------

  async function route(req, res, { adminOnly, publicOnly }) {
    const current = state.cfg;
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendText(res, 400, 'Bad request URL');
    }

    // Reject absurd URLs before doing any filesystem work.
    if (req.url.length > 4096) return sendText(res, 414, 'URI too long');

    if (current.security.forceHttps) {
      const proto = current.server.behindProxy ? req.headers['x-forwarded-proto'] : 'http';
      if (proto === 'http' && req.headers.host) {
        const location = `https://${req.headers.host}${req.url}`;
        res.writeHead(308, { Location: location, 'Content-Length': 0 });
        res.end();
        return 0;
      }
    }

    const adminPath = current.admin.path;
    const isAdminRequest = url.pathname === adminPath || url.pathname.startsWith(adminPath + '/');

    if (isAdminRequest) {
      if (publicOnly) {
        // The admin panel has its own port; do not expose it here as well.
        return staticServer.sendNotFound(req, res, current);
      }
      // The panel loads app.css and app.js with relative URLs, so it must be
      // served from a path with a trailing slash or those resolve one level up.
      if (url.pathname === adminPath) {
        res.writeHead(301, { Location: adminPath + '/' + url.search, 'Content-Length': 0 });
        res.end();
        return 0;
      }
      const subPath = url.pathname.slice(adminPath.length) || '/';
      try {
        return await admin.handle(req, res, subPath === '/' ? '' : subPath, url.searchParams);
      } catch (err) {
        const status = err.statusCode || 500;
        if (status >= 500) {
          stats.errors++;
          log.error('admin error', { path: subPath, message: err.message, stack: err.stack });
        }
        if (res.headersSent) { res.destroy(); return 0; }
        return sendJson(res, status, {
          ok: false,
          error: status >= 500 ? 'internal server error' : err.message,
        });
      }
    }

    if (adminOnly) {
      // On the dedicated admin port, serve nothing but the panel.
      return sendText(res, 404, 'Not found. The admin panel is at ' + adminPath);
    }

    // Health check, handy for uptime monitors and router keepalives.
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, uptime: Math.floor((Date.now() - stats.startedAtMs) / 1000) });
    }

    try {
      return await staticServer.serve(req, res, current, url.pathname);
    } catch (err) {
      stats.errors++;
      log.error('static error', { path: url.pathname, message: err.message });
      if (res.headersSent) { res.destroy(); return 0; }
      return sendText(res, 500, 'Internal server error');
    }
  }

  function makeServer(options) {
    const server = http.createServer((req, res) => {
      const started = process.hrtime.bigint();
      stats.requests++;

      // Never leak the implementation to the public internet.
      res.removeHeader?.('X-Powered-By');
      res.setHeader('Server', 'self-host-starter');

      let bytes = 0;
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        stats.bytesServed += bytes || 0;
        log.access({
          ip: clientIp(req, state.cfg.server.behindProxy),
          method: req.method,
          url: req.url && req.url.slice(0, 512),
          status: res.statusCode,
          bytes: bytes || 0,
          ms: Math.round(ms),
          userAgent: req.headers['user-agent'],
          referer: req.headers.referer,
        });
      });

      route(req, res, options)
        .then((written) => { bytes = written || 0; })
        .catch((err) => {
          stats.errors++;
          log.error('unhandled request error', { message: err.message, stack: err.stack });
          if (!res.headersSent) sendText(res, 500, 'Internal server error');
          else res.destroy();
        });
    });

    server.requestTimeout = state.cfg.server.requestTimeoutMs;
    server.headersTimeout = Math.min(60000, state.cfg.server.requestTimeoutMs);
    server.keepAliveTimeout = 15000;
    // Cap concurrent sockets so a single client cannot exhaust a Pi's memory.
    server.maxRequestsPerSocket = 0;
    server.on('clientError', (err, socket) => {
      if (!socket.writable) return;
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    return server;
  }

  const separateAdmin = cfg.server.adminPort !== null;
  const publicServer = makeServer({ adminOnly: false, publicOnly: separateAdmin });
  const adminServer = separateAdmin ? makeServer({ adminOnly: true, publicOnly: false }) : null;

  // -- listen ---------------------------------------------------------------

  function listenOrExplain(server, port, host, label) {
    return new Promise((resolve) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          log.error(`${label} port ${port} is already in use.`);
          log.error('  Something else is on that port. Pick another with --port, or stop the other program.');
        } else if (err.code === 'EACCES') {
          log.error(`${label} port ${port} needs elevated privileges.`);
          log.error('  Ports below 1024 are restricted. Use a port like 8080 and forward 80 -> 8080 on the router,');
          log.error('  or on Linux grant the binding once with:');
          log.error('    sudo setcap CAP_NET_BIND_SERVICE=+eip "$(readlink -f "$(which node)")"');
        } else {
          log.error(`${label} could not listen on ${host}:${port}`, err.message);
        }
        process.exit(1);
      });
      server.listen(port, host, () => resolve());
    });
  }

  const banner = () => {
    const c = state.cfg;
    const lan = lanAddresses();
    const adminPort = separateAdmin ? c.server.adminPort : c.server.port;

    const lines = [
      '',
      `  Self-Host Starter v${VERSION}`,
      `  ${'─'.repeat(52)}`,
      `  Serving   ${c.paths.siteRoot}`,
      `  Local     http://localhost:${c.server.port}/`,
    ];
    for (const { interface: iface, address } of lan) {
      lines.push(`  LAN       http://${address}:${c.server.port}/   (${iface})`);
    }
    lines.push(`  Admin     http://localhost:${adminPort}${c.admin.path}`);
    if (lan[0]) lines.push(`            http://${lan[0].address}:${adminPort}${c.admin.path}`);
    lines.push(`  ${'─'.repeat(52)}`);

    if (auth.generatedPassword) {
      lines.push('');
      lines.push('  FIRST RUN — an admin account was created:');
      lines.push('');
      lines.push(`      username: admin`);
      lines.push(`      password: ${auth.generatedPassword}`);
      lines.push('');
      lines.push('  Sign in and change it now. It is also saved to');
      lines.push('  data/FIRST-RUN-PASSWORD.txt — delete that file afterwards.');
      lines.push(`  ${'─'.repeat(52)}`);
    }
    lines.push('  Press Ctrl+C to stop.');
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  };

  (async () => {
    await listenOrExplain(publicServer, cfg.server.port, cfg.server.host, 'Website');
    if (adminServer) {
      await listenOrExplain(adminServer, cfg.server.adminPort, cfg.server.host, 'Admin');
    }
    banner();
    ddns.start();
  })();

  // Expire dead sessions once an hour.
  const sweeper = setInterval(() => auth.sweepSessions(), 3600 * 1000);
  if (sweeper.unref) sweeper.unref();

  // -- shutdown -------------------------------------------------------------

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    ddns.stop();
    clearInterval(sweeper);

    const servers = [publicServer, adminServer].filter(Boolean);
    let pending = servers.length;
    for (const server of servers) {
      server.close(() => { if (--pending === 0) process.exit(0); });
      // Drop idle keep-alive sockets so close() is not held open by them.
      server.closeIdleConnections?.();
    }
    // Do not hang forever on a slow client.
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    // Log and keep serving: a single bad request must not take the site down
    // when nobody is around to restart it.
    stats.errors++;
    log.error('uncaught exception', { message: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    stats.errors++;
    log.error('unhandled rejection', { reason: String(reason && reason.stack || reason) });
  });

  return { publicServer, adminServer, ctx };
}

const booted = boot();
if (booted) start(booted.cfg, booted.auth);
