'use strict';
// Minimal extension -> content type map. Deliberately small and offline:
// the whole point of this kit is that it runs from a USB stick with no
// package install step.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

const DEFAULT_TYPE = 'application/octet-stream';

// Types worth running through gzip. Everything else is already compressed
// or too small to benefit.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript|manifest\+json)|image\/svg\+xml)/;

// Extensions we are willing to open in the admin text editor.
const EDITABLE = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md',
  '.xml', '.svg', '.csv', '.webmanifest', '.yml', '.yaml', '.toml',
]);

function extname(filePath) {
  const i = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (i <= slash) return '';
  return filePath.slice(i).toLowerCase();
}

function lookup(filePath) {
  return TYPES[extname(filePath)] || DEFAULT_TYPE;
}

function isCompressible(contentType) {
  return COMPRESSIBLE.test(contentType || '');
}

function isEditable(filePath) {
  return EDITABLE.has(extname(filePath));
}

module.exports = { lookup, extname, isCompressible, isEditable, TYPES, DEFAULT_TYPE };
