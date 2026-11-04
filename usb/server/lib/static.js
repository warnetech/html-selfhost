'use strict';
// Static file serving for the public website.
//
// Supports conditional requests (ETag / Last-Modified), byte ranges for
// media, on-the-fly gzip for text, clean URLs and a custom 404 page.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');

const mime = require('./mime');
const { resolveWithin, isInside, PathError } = require('./safepath');
const { securityHeaders, escapeHtml, formatBytes } = require('./http');

const MIN_COMPRESS_BYTES = 1024;

function weakEtag(stat) {
  // Size + mtime is enough to detect edits made through the admin panel,
  // and avoids hashing large media on every request.
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function cacheControlFor(contentType) {
  if (contentType.startsWith('text/html')) {
    // HTML must revalidate, otherwise an edit in the admin panel appears to
    // do nothing until the visitor hard-refreshes.
    return 'no-cache';
  }
  return 'public, max-age=3600, must-revalidate';
}

async function statIfFile(absolute) {
  try {
    const stat = await fsp.stat(absolute);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// Refuse to serve anything that a symlink points outside the site root at.
async function assertRealPathInside(root, absolute) {
  let real;
  try {
    real = await fsp.realpath(absolute);
  } catch {
    return false;
  }
  const realRoot = await fsp.realpath(root).catch(() => path.resolve(root));
  return isInside(realRoot, real);
}

// Work out which file on disk answers this URL path.
// Returns { absolute, stat, relative } or null.
async function resolveTarget(cfg, urlPath) {
  const siteRoot = cfg.paths.siteRoot;
  const { relative, absolute } = resolveWithin(siteRoot, decodeURIComponent(urlPath));

  let stat;
  try {
    stat = await fsp.stat(absolute);
  } catch {
    stat = null;
  }

  if (stat && stat.isFile()) {
    return { absolute, stat, relative, kind: 'file' };
  }

  if (stat && stat.isDirectory()) {
    const indexPath = path.join(absolute, cfg.site.indexFile);
    const indexStat = await statIfFile(indexPath);
    if (indexStat) {
      return { absolute: indexPath, stat: indexStat, relative: path.posix.join(relative, cfg.site.indexFile), kind: 'index' };
    }
    if (cfg.site.directoryListing) {
      return { absolute, stat, relative, kind: 'listing' };
    }
    return null;
  }

  // Clean URLs: /about -> /about.html, /blog/post -> /blog/post.html
  if (cfg.site.cleanUrls && relative && !mime.extname(relative)) {
    const htmlPath = absolute + '.html';
    const htmlStat = await statIfFile(htmlPath);
    if (htmlStat) {
      return { absolute: htmlPath, stat: htmlStat, relative: relative + '.html', kind: 'clean' };
    }
  }

  return null;
}

function parseRange(header, size) {
  // Single range only. Multi-range needs multipart/byteranges, which is not
  // worth the complexity for a personal site server.
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  let start;
  let end;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function clientAcceptsGzip(req) {
  const header = req.headers['accept-encoding'] || '';
  return /\bgzip\b/.test(header) && !/\bgzip\s*;\s*q=0(\.0+)?\b/.test(header);
}

function isFresh(req, etag, lastModified) {
  const inm = req.headers['if-none-match'];
  if (inm) {
    // A client may echo several tags; a match on any of them means fresh.
    const tags = inm.split(',').map((t) => t.trim());
    if (tags.includes('*') || tags.includes(etag)) return true;
    // Compare ignoring the weak marker, per RFC 7232 weak comparison.
    const bare = etag.replace(/^W\//, '');
    if (tags.some((t) => t.replace(/^W\//, '') === bare)) return true;
    return false;
  }
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const since = Date.parse(ims);
    if (Number.isFinite(since) && lastModified <= since + 999) return true;
  }
  return false;
}

function renderListing(relative, entries) {
  const rows = entries
    .map((e) => {
      const href = escapeHtml(encodeURIComponent(e.name) + (e.isDir ? '/' : ''));
      const size = e.isDir ? '&mdash;' : escapeHtml(formatBytes(e.size));
      return `<tr><td><a href="${href}">${escapeHtml(e.name)}${e.isDir ? '/' : ''}</a></td><td>${size}</td></tr>`;
    })
    .join('\n');
  const here = escapeHtml('/' + relative);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Index of ${here}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:48rem;padding:0 1rem;color:#1a1a1a}
table{width:100%;border-collapse:collapse}td{padding:.35rem .5rem;border-bottom:1px solid #e5e5e5}
td:last-child{text-align:right;color:#666;white-space:nowrap}a{color:#0b5fff;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:1.1rem;font-family:ui-monospace,monospace}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td{border-color:#333}a{color:#6ea8ff}}
</style></head><body>
<h1>Index of ${here}</h1>
<table><tbody>
${relative ? '<tr><td><a href="../">../</a></td><td>&mdash;</td></tr>' : ''}
${rows}
</tbody></table>
</body></html>
`;
}

async function serveListing(req, res, cfg, target) {
  const dirents = await fsp.readdir(target.absolute, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    let size = 0;
    if (dirent.isFile()) {
      try { size = (await fsp.stat(path.join(target.absolute, dirent.name))).size; } catch { size = 0; }
    }
    entries.push({ name: dirent.name, isDir: dirent.isDirectory(), size });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  const html = Buffer.from(renderListing(target.relative, entries), 'utf8');
  securityHeaders(res, cfg, { isHtml: true });
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return 0; }
  res.end(html);
  return html.length;
}

// Send a file. Returns the number of body bytes written (approximate for
// compressed responses, which is fine — it only feeds the access log).
function sendFile(req, res, cfg, absolute, stat, statusCode = 200) {
  const contentType = mime.lookup(absolute);
  const etag = weakEtag(stat);
  const lastModified = Math.floor(stat.mtimeMs / 1000) * 1000;

  securityHeaders(res, cfg, { isHtml: contentType.startsWith('text/html') });
  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
  res.setHeader('Cache-Control', cacheControlFor(contentType));
  res.setHeader('Accept-Ranges', 'bytes');

  if (statusCode === 200 && isFresh(req, etag, lastModified)) {
    res.writeHead(304);
    res.end();
    return 0;
  }

  const range = statusCode === 200 ? parseRange(req.headers.range, stat.size) : null;
  if (range && range.unsatisfiable) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.writeHead(416);
    res.end();
    return 0;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': length,
    });
    if (req.method === 'HEAD') { res.end(); return 0; }
    pipeline(fs.createReadStream(absolute, { start: range.start, end: range.end }), res, () => {});
    return length;
  }

  const wantsGzip =
    cfg.server.compress &&
    mime.isCompressible(contentType) &&
    stat.size >= MIN_COMPRESS_BYTES &&
    clientAcceptsGzip(req);

  if (wantsGzip) {
    // Length is unknown ahead of time, so this response is chunked.
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.writeHead(statusCode);
    if (req.method === 'HEAD') { res.end(); return 0; }
    pipeline(fs.createReadStream(absolute), zlib.createGzip({ level: 6 }), res, () => {});
    return stat.size;
  }

  res.setHeader('Content-Length', stat.size);
  if (mime.isCompressible(contentType)) res.setHeader('Vary', 'Accept-Encoding');
  res.writeHead(statusCode);
  if (req.method === 'HEAD') { res.end(); return 0; }
  pipeline(fs.createReadStream(absolute), res, () => {});
  return stat.size;
}

async function sendNotFound(req, res, cfg) {
  const custom = path.join(cfg.paths.siteRoot, cfg.site.notFoundFile);
  const stat = await statIfFile(custom);
  if (stat && (await assertRealPathInside(cfg.paths.siteRoot, custom))) {
    return sendFile(req, res, cfg, custom, stat, 404);
  }
  const body = Buffer.from(
    '<!doctype html><meta charset="utf-8"><title>404 Not Found</title>' +
    '<h1>404 &mdash; Not Found</h1><p>That page is not on this site.</p>',
    'utf8'
  );
  securityHeaders(res, cfg, { isHtml: true });
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return 0; }
  res.end(body);
  return body.length;
}

// Entry point. Returns bytes written so the caller can log them.
async function serve(req, res, cfg, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 });
    res.end();
    return 0;
  }

  let target;
  try {
    target = await resolveTarget(cfg, urlPath);
  } catch (err) {
    if (err instanceof PathError) return sendNotFound(req, res, cfg);
    throw err;
  }

  if (!target) return sendNotFound(req, res, cfg);

  if (!(await assertRealPathInside(cfg.paths.siteRoot, target.absolute))) {
    // A symlink pointing out of the site root: treat as missing rather than
    // confirming it exists.
    return sendNotFound(req, res, cfg);
  }

  // Redirect /dir to /dir/ so relative links inside the page resolve.
  if (target.kind === 'listing' || (target.kind === 'index' && !urlPath.endsWith('/'))) {
    if (!urlPath.endsWith('/')) {
      res.writeHead(301, { Location: urlPath + '/', 'Content-Length': 0 });
      res.end();
      return 0;
    }
  }

  if (target.kind === 'listing') return serveListing(req, res, cfg, target);
  return sendFile(req, res, cfg, target.absolute, target.stat);
}

module.exports = { serve, sendFile, sendNotFound, resolveTarget, parseRange, weakEtag };
