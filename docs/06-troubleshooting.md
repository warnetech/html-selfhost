# 6 — Troubleshooting

Symptom first, then the fix.

---

## The server will not start

### `Node.js was not found`

Node is not installed, or not on the `PATH` for the user running the launcher.

```bash
node --version     # must print v18 or higher
```

Install it per [guide 01](01-quickstart.md#step-2--install-nodejs-on-the-host),
or drop a portable build on the stick at `runtime/bin/node`
(`runtime\node.exe` on Windows) — the launchers check there first.

### `port 8080 is already in use`

Something else has the port.

```bash
sudo ss -tlnp | grep 8080     # Linux — shows the process
netstat -ano | findstr :8080  # Windows — gives a PID for Task Manager
```

Either stop that program, or run on a different port and update the modem's
forwarding rule:

```bash
./start-linux.sh --port 8081
```

### `port 80 needs elevated privileges`

Linux reserves ports below 1024 for root. Use 8080 and forward external 80 to
it on the modem — that is the recommended arrangement anyway. If you really
want to bind 80 directly:

```bash
sudo setcap CAP_NET_BIND_SERVICE=+eip "$(readlink -f "$(which node)")"
```

### `data/users.json is corrupt`

The file was edited by hand or the stick was pulled mid-write. Delete it and
restart — a fresh `admin` account is generated and the new password printed.

### `data/config.json is not valid JSON`

The server keeps running on defaults and saves your broken file as
`config.json.broken` so you can see what went wrong. Fix it, or delete
`config.json` to start from defaults.

---

## The site works locally but not from the internet

Work through this in order — the answer is almost always one of the first three.

### 1. Are you testing from outside?

**Turn Wi-Fi off on your phone and use mobile data.** Most consumer modems,
Telstra's included, do not support NAT hairpinning: your public address will
fail from inside your own house even when it works perfectly from outside.
Testing from the LAN is the single most common false alarm.

### 2. Is the LAN address still the one you forwarded?

```bash
hostname -I        # Linux
ipconfig           # Windows
```

If the host got a new DHCP lease, the forwarding rule now points at nothing.
Reserve the address on the modem
([guide 02](02-telstra-router-setup.md#step-1--give-the-host-machine-a-fixed-lan-address)).

### 3. Are you behind CGNAT?

Compare the modem's WAN IP with what the internet sees:

```bash
curl -s https://api.ipify.org; echo
```

If they differ, or the modem's WAN IP starts with `100.64.`–`100.127.`, port
forwarding cannot work. Telstra 4G/5G Home Internet is always in this
situation. Use
[Cloudflare Tunnel](03-going-online.md#option-3--cloudflare-tunnel-no-port-forwarding-needed).

### 4. Is the host's own firewall blocking it?

```bash
sudo ufw allow 8080/tcp
sudo ufw status
```

On Windows, check Windows Defender Firewall has an inbound rule for Node.js on
**Private** networks.

### 5. Is the forwarding rule actually right?

Re-read it in the modem UI. The usual mistakes: external and internal ports
swapped, UDP instead of TCP, the rule saved but not enabled, or it points at an
old device entry.

### 6. Is the port genuinely open?

From outside your network:

```bash
curl -v --max-time 10 http://<your-public-ip>/
```

- **Connection refused** — the packet reached your modem and something rejected
  it. Check the forward and the host firewall.
- **Connection timed out** — the packet never got there. CGNAT, or the modem is
  dropping it silently.

---

## The domain name does not resolve

```bash
dig +short mysite.duckdns.org
nslookup mysite.duckdns.org      # Windows
```

- **No answer** — the DDNS update has not run or has failed. Check
  **Dashboard → Dynamic DNS** for the last error, then hit **Update DNS now**.
- **The wrong address** — your IP changed and the updater has not caught up.
  Force an update; if it keeps drifting, shorten the interval.
- **The right address but the site does not load** — DNS is fine, the problem
  is port forwarding. Go back to the section above.

DNS changes also take time to propagate. DuckDNS is near-instant; a domain with
a long TTL can take up to an hour.

---

## The admin panel

### It loads but the styling is broken

The panel's assets are loaded relative to its own path. Make sure you are at
`http://host:8080/__admin/` — the server redirects the version without the
trailing slash, so this only happens if something is rewriting URLs in front of
the server.

### `not signed in` every time I do something

The session cookie is scoped to the admin path. If you changed the admin path
while signed in, sign in again at the new path.

Cookies are also rejected if the browser blocks third-party or all cookies for
the site. Check the browser's site settings.

### Signed out immediately after changing the password

Working as designed — changing the password invalidates every session,
including the current one. Sign in again with the new password.

### Locked out after too many attempts

Wait it out — 15 minutes by default, doubling with each further failure. If you
have access to the host, restarting the server clears the in-memory throttle.
If you have genuinely lost the password, delete `data/users.json` and restart.

### `EACCES` or `EROFS` when saving a file

The stick is mounted read-only, or the user running the server cannot write to
it.

```bash
mount | grep MYSTICK          # is it "ro"?
sudo mount -o remount,rw /media/you/MYSTICK
```

FAT32 sticks mounted by the desktop are usually owned by the desktop user. If
the server runs as a systemd service under a different user, mount the stick
with `uid=` set to that user, or run the service as that user.

---

## Performance

### The site is slow for visitors

Home connections have far less upload than download — often 20–40 Mbps up on
NBN. That upload is what serves your visitors. Fixes, in order of payoff:

1. **Compress images.** A 4 MB photo is the problem, not the server. Resize to
   the size it is actually displayed at and export as WebP.
2. **Confirm gzip is on** — **Settings → Server → Compress text responses**.
3. **Put Cloudflare in front** (proxied DNS or a tunnel). Static assets are
   then served from their edge and never touch your connection.

### The Raspberry Pi is running hot or the site stalls

Check `Dashboard → Host` for load average. A static site should sit near zero.
If it is high, something else on the Pi is the cause — or you are being
scraped, which the access log will show.

---

## Files and the USB stick

### Edits in the panel do not show up on the site

HTML is served with `Cache-Control: no-cache`, so a normal reload should show
changes. Other assets are cached for an hour — hard-reload with **Ctrl+Shift+R**
/ **Cmd+Shift+R**, or rename the file to bust the cache.

### The stick disconnected and everything stopped

USB sticks drop out, especially on a Pi with marginal power. Check
`dmesg | tail`. Options: a powered USB hub, a better stick, or copy the kit to
the host's internal storage and keep the stick as the backup.

### The modem's USB share keeps disappearing

Expected — Telstra modems drop SMB shares on reboot and after firmware updates.
Mount it via `/etc/fstab` with `nofail,_netdev,x-systemd.automount` so the host
remounts it automatically instead of hanging at boot
([guide 02](02-telstra-router-setup.md#2-mount-the-share-on-the-host)).

---

## Diagnostics

```bash
# Validate configuration without starting the server
node usb/server/server.js --check

# Full end-to-end test of a running server (48 checks)
tools/smoke-test.sh

# Live service logs
sudo journalctl -u selfhost -f

# The server's own logs
tail -f usb/data/access.log
tail -f usb/data/error.log
```

The **Logs** tab in the admin panel shows the same two files if you cannot get
to a shell.
