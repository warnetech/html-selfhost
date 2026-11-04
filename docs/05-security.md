# 5 — Security

What this server protects against, what it does not, and what you have to do.

Opening a port on your home router puts a machine on your own network directly
on the internet. Within hours, automated scanners will find it and start trying
things. That is normal and expected — but it means the defaults matter.

---

## Do these five things

1. **Change the admin password.** The generated one is strong, but it was
   written to `data/FIRST-RUN-PASSWORD.txt` in plain text. Change the password,
   then delete that file.
2. **Rename the admin path.** `/__admin` is in this repo and therefore in every
   scanner's word list eventually. Change it under **Settings → Admin panel** to
   something unguessable, e.g. `/manage-x7k2p`. This is not a security boundary
   on its own — it just removes you from untargeted scanning.
3. **Forward only the ports you need.** External 80 (and 443) to the host. Do
   not put the host in the modem's DMZ, and do not forward SSH, SMB (445) or
   the modem's own admin interface.
4. **Keep Node.js updated** on the host. It is the software actually exposed to
   the internet.
5. **Consider not exposing the panel at all.** Tick **Local network only** and
   reach it over Tailscale or WireGuard. You get remote management without a
   login form facing the public internet — the strongest option by a wide
   margin, and free.

---

## What the server does for you

### Passwords

Stored as **scrypt** hashes (N=16384, r=8, p=1, 64-byte output) with a random
16-byte salt per user. Verification is a constant-time comparison. An unknown
username still runs a throwaway hash, so response timing cannot be used to
discover which accounts exist.

Passwords must be at least 12 characters and are rejected if they contain
well-known weak phrases.

### Login throttling

Five failures from an IP address triggers a 15-minute lockout. Each subsequent
failure doubles it, capped at one hour. Successful sign-in clears the counter.
The failed attempt is written to the error log with the source address.

### Sessions

A 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie scoped to the
admin path. The `Secure` flag is added automatically when HTTPS is configured.
Sessions expire after 12 hours by default and are swept hourly.

Changing the password invalidates **every** session for that user immediately,
including the one that made the change. That is deliberate: if you are changing
the password because you think someone else has it, half-measures are useless.

### CSRF

Every mutating request needs both the session cookie and an `X-CSRF-Token`
header matching a per-session secret, compared in constant time. When an
`Origin` header is present it must match the request's `Host`. A hostile page
in another tab cannot make your browser edit your site.

### Path traversal

Every filesystem path from a request goes through one containment function
before anything is opened. It rejects:

- `..` segments (rejected outright, not silently normalised away)
- absolute paths, drive letters (`C:`), UNC prefixes (`\\server`)
- NUL bytes and control characters
- Windows reserved names (`con`, `nul`, `lpt1`…)
- dotfiles, except `.well-known` which ACME needs
- paths deeper than 32 levels or segments over 255 characters

The resolved absolute path is then re-checked against the root prefix, and
after `realpath()` resolution as well — so a symlink pointing at `/etc` is
refused rather than followed.

### Response headers

Public pages get `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Cross-Origin-Opener-Policy: same-origin` and a configurable
Content-Security-Policy. The admin panel gets a much stricter CSP of its own
(`default-src 'none'`, no inline scripts or styles) plus `no-store` caching and
`noindex, nofollow`.

### Resource limits

Request bodies are capped and the socket is destroyed if a client keeps sending
past the limit. URLs over 4096 bytes are refused. Request and header timeouts
are enforced. Directory walks are bounded in depth and entry count. Logs rotate
on size. An unhandled exception is logged and the server keeps serving rather
than dying while nobody is watching.

### Secrets

DDNS tokens are masked as `••••••••` in every API response and never sent back
to the browser. Sending the bullets back means "leave the stored value alone".
`users.json`, `sessions.json` and `FIRST-RUN-PASSWORD.txt` are written mode
`0600` where the filesystem supports it — note that **FAT32 and exFAT have no
permission bits**, so on those filesystems anyone with physical access to the
stick can read the hashes.

---

## What this server does **not** do

Know these before you rely on it.

- **No TLS.** It speaks HTTP only. Put Caddy or Cloudflare Tunnel in front for
  HTTPS ([guide 03](03-going-online.md#https)). Without one, admin passwords
  cross the network in plain text — never sign in to the panel over the public
  internet on plain HTTP.
- **No DDoS protection.** A home upload link is trivially saturated. Cloudflare
  (proxied DNS or a tunnel) is the practical answer.
- **No server-side code.** Static files only — no PHP, no database, no form
  handling. This is a feature: there is no application logic to exploit.
- **No multi-user roles.** Anyone who can sign in can edit everything.
- **No automatic updates.** You update Node.js; nothing here phones home.
- **No encryption at rest.** Lose the stick and someone has your site files and
  your password hashes. Use full-disk encryption on the stick if that matters.

---

## Reducing exposure further

**Split the ports.** Set **Separate admin port** to `9443` and forward only
external 80 → 8080 on the modem. The public site is reachable; the panel is
LAN-only, with no configuration that can accidentally expose it.

**Or lock it to the LAN and use a VPN.** Tick **Local network only** — the
panel then refuses any client that is not on a private address. Install
Tailscale on the host and your phone, and the panel is reachable from anywhere
over the VPN without a single open port.

**Watch the logs.** The error log records every failed sign-in with its source
address. A burst of them from one address is someone trying; a burst from many
addresses is a botnet, and a good moment to switch to the VPN approach.

---

## If you think you have been compromised

1. Unplug the network cable — the site being down is the least of your problems.
2. Change the admin password (this kills every session).
3. Read `data/error.log` and `data/access.log` for what was requested and when.
4. Compare `site/` against a known-good copy; the panel can only write there,
   but check anyway.
5. Delete `data/sessions.json` to force every device to sign in again.
6. Update Node.js before going back online.

---

**Next:** [06 — Troubleshooting](06-troubleshooting.md).
