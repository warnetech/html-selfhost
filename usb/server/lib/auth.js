'use strict';
// Password storage, sessions and login throttling.
//
// Passwords are stored as scrypt hashes with a per-user random salt. There
// is no password recovery: if the operator loses it they delete
// data/users.json and the server mints a fresh admin account on next boot.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./log');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_BYTES = 32;
const MIN_PASSWORD_LENGTH = 12;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

// A throwaway hash used to keep "unknown user" and "wrong password" taking
// roughly the same time, so the login form cannot be used to enumerate
// account names.
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

function scryptHash(password, saltHex) {
  return crypto
    .scryptSync(Buffer.from(password, 'utf8'), Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
      maxmem: 96 * 1024 * 1024, // scrypt needs ~128*N*r bytes; give it headroom.
    })
    .toString('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length mismatch is not measurably faster.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Human-friendly but high-entropy: 4 groups of 5 chars from an unambiguous
// alphabet is ~93 bits, and can be read off a screen without confusing
// 0/O or 1/l.
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789ACDEFGHJKLMNPQRSTUVWXYZ';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let chunk = '';
    for (let i = 0; i < 5; i++) {
      chunk += alphabet[crypto.randomInt(alphabet.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

function checkPasswordStrength(password) {
  if (typeof password !== 'string') return 'password must be text';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) return 'password must be at most 200 characters';
  const weak = ['password', 'admin', '12345678', 'letmein', 'changeme', 'qwerty'];
  const lowered = password.toLowerCase();
  if (weak.some((w) => lowered.includes(w))) return 'password contains a well-known weak phrase';
  return null;
}

function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
  // chmod after rename too: the mode on open() is masked by umask.
  if (mode !== undefined) {
    try { fs.chmodSync(file, mode); } catch { /* FAT32 has no permission bits */ }
  }
}

class Auth {
  constructor(cfg) {
    this.cfg = cfg;
    this.usersFile = cfg.paths.usersFile;
    this.sessionsFile = cfg.paths.sessionsFile;
    this.users = new Map();
    this.sessions = new Map();
    this.throttle = new Map(); // ip -> { fails, lockedUntil }
    this.generatedPassword = null;
    this._saveTimer = null;
  }

  // ---- users ------------------------------------------------------------

  load() {
    this._loadUsers();
    this._loadSessions();
  }

  _loadUsers() {
    if (!fs.existsSync(this.usersFile)) {
      this._bootstrapAdmin();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.usersFile, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      throw new Error(
        `data/users.json is corrupt (${err.message}). Delete it to have a new admin account generated.`
      );
    }
    for (const user of parsed.users || []) {
      if (!user.username || !user.salt || !user.hash) continue;
      this.users.set(user.username.toLowerCase(), user);
    }
    if (this.users.size === 0) this._bootstrapAdmin();
  }

  _bootstrapAdmin() {
    const password = generatePassword();
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      username: 'admin',
      salt,
      hash: scryptHash(password, salt),
      algo: 'scrypt',
      params: { ...SCRYPT },
      createdAt: new Date().toISOString(),
      passwordChangedAt: new Date().toISOString(),
      mustChangePassword: true,
    };
    this.users.set('admin', user);
    this._saveUsers();
    this.generatedPassword = password;

    // Also drop it in a file, because the operator is often setting this up
    // headless over SSH or from a start script whose console they closed.
    const noteFile = path.join(this.cfg.paths.dataDir, 'FIRST-RUN-PASSWORD.txt');
    const note = [
      'Self-Host Starter — first run credentials',
      '',
      `  username: admin`,
      `  password: ${password}`,
      '',
      'Sign in at the admin URL printed by the server, change this password,',
      'then DELETE THIS FILE. It is not needed again and anyone who can read',
      'the USB stick can read it.',
      '',
    ].join('\n');
    try {
      writeJsonAtomicText(noteFile, note, 0o600);
    } catch (err) {
      log.warn('could not write FIRST-RUN-PASSWORD.txt', err.message);
    }
  }

  _saveUsers() {
    writeJsonAtomic(this.usersFile, { version: 1, users: [...this.users.values()] }, 0o600);
  }

  listUsers() {
    return [...this.users.values()].map((u) => ({
      username: u.username,
      createdAt: u.createdAt,
      passwordChangedAt: u.passwordChangedAt,
      mustChangePassword: !!u.mustChangePassword,
    }));
  }

  verify(username, password) {
    const user = this.users.get(String(username || '').toLowerCase());
    if (!user) {
      scryptHash(String(password || ''), DUMMY_SALT); // equalise timing
      return null;
    }
    const candidate = scryptHash(String(password || ''), user.salt);
    return timingSafeEqualHex(candidate, user.hash) ? user : null;
  }

  changePassword(username, currentPassword, newPassword) {
    const user = this.verify(username, currentPassword);
    if (!user) return { ok: false, error: 'current password is incorrect' };

    const weakness = checkPasswordStrength(newPassword);
    if (weakness) return { ok: false, error: weakness };
    if (newPassword === currentPassword) {
      return { ok: false, error: 'new password must differ from the current one' };
    }

    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = scryptHash(newPassword, user.salt);
    user.passwordChangedAt = new Date().toISOString();
    user.mustChangePassword = false;
    this._saveUsers();

    // Changing a password invalidates every existing session for that user,
    // which is the point of changing it after a suspected compromise.
    for (const [token, session] of this.sessions) {
      if (session.username === user.username) this.sessions.delete(token);
    }
    this._saveSessions();

    // The generated first-run password is now dead; stop advertising it.
    this.generatedPassword = null;
    const noteFile = path.join(this.cfg.paths.dataDir, 'FIRST-RUN-PASSWORD.txt');
    try { if (fs.existsSync(noteFile)) fs.unlinkSync(noteFile); } catch { /* best effort */ }

    return { ok: true };
  }

  // ---- sessions ---------------------------------------------------------

  _loadSessions() {
    if (!fs.existsSync(this.sessionsFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      const now = Date.now();
      for (const session of parsed.sessions || []) {
        if (session.expiresAt > now && this.users.has(session.username.toLowerCase())) {
          this.sessions.set(session.token, session);
        }
      }
    } catch {
      // A corrupt session file just means everyone logs in again.
      log.warn('data/sessions.json unreadable; starting with no active sessions');
    }
  }

  // Debounced so a burst of admin requests does not hammer the stick.
  _saveSessions() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        writeJsonAtomic(this.sessionsFile, { sessions: [...this.sessions.values()] }, 0o600);
      } catch (err) {
        log.warn('could not persist sessions', err.message);
      }
    }, 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  createSession(user, { ip, userAgent }) {
    const token = crypto.randomBytes(SESSION_BYTES).toString('base64url');
    const session = {
      token,
      csrf: crypto.randomBytes(24).toString('base64url'),
      username: user.username,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.cfg.admin.sessionHours * 3600 * 1000,
      ip: ip || null,
      userAgent: (userAgent || '').slice(0, 200),
    };
    this.sessions.set(token, session);
    this._saveSessions();
    return session;
  }

  getSession(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this._saveSessions();
      return null;
    }
    return session;
  }

  destroySession(token) {
    if (token && this.sessions.delete(token)) this._saveSessions();
  }

  sweepSessions() {
    const now = Date.now();
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
        removed++;
      }
    }
    if (removed) this._saveSessions();
    // Forget throttle entries whose lockout has long expired.
    for (const [ip, entry] of this.throttle) {
      if (entry.lockedUntil < now - 3600 * 1000) this.throttle.delete(ip);
    }
    return removed;
  }

  // ---- login throttling -------------------------------------------------

  lockoutRemainingMs(ip) {
    const entry = this.throttle.get(ip);
    if (!entry || !entry.lockedUntil) return 0;
    return Math.max(0, entry.lockedUntil - Date.now());
  }

  recordFailure(ip) {
    const entry = this.throttle.get(ip) || { fails: 0, lockedUntil: 0 };
    entry.fails += 1;
    if (entry.fails >= this.cfg.security.loginMaxAttempts) {
      // Back off harder each time the limit is hit again, capped so a
      // legitimate operator is never locked out for more than an hour.
      const overshoot = entry.fails - this.cfg.security.loginMaxAttempts;
      const minutes = Math.min(60, this.cfg.security.loginLockoutMinutes * Math.pow(2, overshoot));
      entry.lockedUntil = Date.now() + minutes * 60 * 1000;
    }
    this.throttle.set(ip, entry);
    return entry;
  }

  recordSuccess(ip) {
    this.throttle.delete(ip);
  }
}

// Small helper kept next to writeJsonAtomic so the two stay in step.
function writeJsonAtomicText(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
  if (mode !== undefined) {
    try { fs.chmodSync(file, mode); } catch { /* FAT32 has no permission bits */ }
  }
}

module.exports = { Auth, generatePassword, checkPasswordStrength, MIN_PASSWORD_LENGTH, USERNAME_RE };
