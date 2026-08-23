'use strict';
// Path containment helpers. Every filesystem path that originates from a
// network request must go through resolveWithin() before it is touched.

const path = require('path');

const RESERVED_WINDOWS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
    this.statusCode = 400;
  }
}

// Dot-prefixed directories that are still safe to expose publicly.
// ACME HTTP-01 validation writes into .well-known, so blocking it outright
// would break Let's Encrypt renewals.
const PUBLIC_DOT_SEGMENTS = new Set(['.well-known']);

// Normalise a client-supplied path into a root-relative POSIX path.
// Rejects NUL bytes, absolute paths, drive letters, UNC prefixes and dotfiles.
function normalizeRelative(input, { allowDotfiles = false, allowedDotSegments = PUBLIC_DOT_SEGMENTS } = {}) {
  if (typeof input !== 'string') throw new PathError('path must be a string');
  if (input.includes('\0')) throw new PathError('path contains a NUL byte');

  let raw = input.trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(raw)) throw new PathError('drive letters are not allowed');
  if (raw.startsWith('//')) throw new PathError('UNC paths are not allowed');

  const segments = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Refuse rather than silently popping: a request containing ".." is
      // always a bug or an attack, never something we want to guess at.
      throw new PathError('path traversal is not allowed');
    }
    if (!allowDotfiles && segment.startsWith('.') && !allowedDotSegments.has(segment.toLowerCase())) {
      throw new PathError('dotfiles are not allowed');
    }
    const bare = segment.split('.')[0].toLowerCase();
    if (RESERVED_WINDOWS.has(bare)) {
      throw new PathError(`"${segment}" is a reserved filename on Windows`);
    }
    if (/[<>:"|?*]/.test(segment) || /[\x00-\x1f]/.test(segment)) {
      throw new PathError(`"${segment}" contains characters that are illegal in filenames`);
    }
    if (segment.length > 255) throw new PathError('path segment is too long');
    segments.push(segment);
  }
  if (segments.length > 32) throw new PathError('path is nested too deeply');
  return segments.join('/');
}

// Resolve a client-supplied path against a root and prove the result is
// still inside that root. Returns { relative, absolute }.
function resolveWithin(root, input, options = {}) {
  const relative = normalizeRelative(input || '', options);
  const rootResolved = path.resolve(root);
  const absolute = path.resolve(rootResolved, relative);

  // Belt and braces: even after normalisation, verify containment on the
  // resolved string so a symlink-free root can never be escaped.
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw new PathError('path escapes the permitted root');
  }
  return { relative, absolute, root: rootResolved };
}

// True when `child` lives at or below `parent` on disk. Used to re-check a
// path after fs.realpath() has followed any symlinks.
function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

module.exports = { PathError, normalizeRelative, resolveWithin, isInside, PUBLIC_DOT_SEGMENTS };
