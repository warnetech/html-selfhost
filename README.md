# Self-Host Starter

A complete, zero-dependency website host that lives on a USB stick, runs behind
your home router, and is managed remotely from a browser.

Copy the `usb/` folder onto a USB drive, plug it into an always-on machine on
your network, double-click the launcher, and you have a website. Point your
Telstra modem's port forwarding at it and the world can reach it.

---

## Read this first: what a Telstra modem can and cannot do

The obvious plan — plug the USB stick into the back of the Telstra Smart Modem
and have the modem serve the website — **does not work, on any Telstra modem.**

Telstra Smart Modems (Gen 1, Gen 2 / Technicolor DJA0231, Gen 3 / Sagemcom
F@ST 5366) do have a USB port, but the firmware uses it for exactly two things:
SMB/Windows file sharing and DLNA media streaming. There is no shell, no
package manager, no way to install or execute your own software, and no
supported way to change that. The modem can *hold* your files. It cannot *serve
them as a website*.

So this kit splits the job the way the hardware actually allows:

```
                                          ┌──────────────────────────┐
   Internet ──►  Telstra Smart Modem  ──► │  Always-on host machine  │
                 · public IP address      │  · USB stick plugged in  │
                 · port 80 forwarded  ────┤  · runs server.js        │
                 · DHCP + firewall        │  · serves site/ folder   │
                                          └──────────────────────────┘
```

The "always-on host" is any cheap computer already capable of running Node.js:

| Host | Cost | Power draw | Notes |
|---|---|---|---|
| Raspberry Pi Zero 2 W | ~$25 | ~1 W | Plenty for a static site |
| Raspberry Pi 4 / 5 | ~$80+ | ~4 W | Comfortable headroom |
| Old laptop | $0 | ~15 W | Close the lid, disable sleep |
| Mini PC / thin client | ~$60 used | ~8 W | Quiet and reliable |

**If you want the stick physically in the modem**, you can have that too — see
[Option B](docs/02-telstra-router-setup.md#option-b--keep-the-stick-in-the-modem).
The modem shares the USB drive over your LAN, the host mounts that share, and
the server reads the website straight off it. The files really do live on the
modem's USB port; the host is only the engine.

---

## What you get

- **A real web server** — static files, clean URLs, gzip, ETag caching, byte
  ranges for media, custom 404 page. Written against the Node standard library
  only: no `npm install`, ever, so the stick works on an offline machine.
- **A remote admin panel over HTML** — sign in from any browser, anywhere, to
  edit pages in a code editor, upload images, create and rename files, change
  settings, and read the access log. Works on a phone.
- **Dynamic DNS built in** — DuckDNS, Cloudflare, or any generic update URL, so
  your domain follows your connection when Telstra hands you a new address.
- **Security that assumes the internet is hostile** — scrypt password hashing,
  CSRF protection, login rate limiting with escalating lockout, path-traversal
  containment, no-index headers on the panel, and secrets that are never echoed
  back to the browser.

---

## Quick start

```bash
# 1. Copy the kit onto the USB stick (the usb/ folder becomes the stick's root)
cp -r usb/. /media/YOU/MYSTICK/

# 2. Plug the stick into the host machine and start it
cd /media/YOU/MYSTICK
./start-linux.sh              # Linux / Raspberry Pi
# START-MAC.command           # macOS — double-click in Finder
# START-WINDOWS.bat           # Windows — double-click
```

The server prints its addresses and, on the very first run, a generated admin
password:

```
  Self-Host Starter v1.0.0
  ────────────────────────────────────────────────────
  Serving   /media/YOU/MYSTICK/site
  Local     http://localhost:8080/
  LAN       http://192.168.0.42:8080/   (eth0)
  Admin     http://192.168.0.42:8080/__admin
  ────────────────────────────────────────────────────

  FIRST RUN — an admin account was created:

      username: admin
      password: Mdjvd-xiwz9-EUV4a-sqTR2
```

Open the admin URL, sign in, **change that password immediately**, and start
editing. Then follow the router guide to put it online.

---

## Documentation

| Guide | What it covers |
|---|---|
| [01 — Quick start](docs/01-quickstart.md) | Preparing the stick, picking a host, first boot, running it 24/7 |
| [02 — Telstra router setup](docs/02-telstra-router-setup.md) | Static LAN IP, port forwarding on Gen 2 / Gen 3, the modem's USB share |
| [03 — Going online](docs/03-going-online.md) | Public IP, dynamic DNS, domain names, HTTPS, Cloudflare Tunnel |
| [04 — Admin panel](docs/04-admin-panel.md) | Every screen and what it does |
| [05 — Security](docs/05-security.md) | The threat model, what is protected, what you must do |
| [06 — Troubleshooting](docs/06-troubleshooting.md) | Symptom-by-symptom fixes |

---

## Repository layout

```
usb/                      ← copy the CONTENTS of this onto the USB stick
├── START-WINDOWS.bat     Windows launcher
├── START-MAC.command     macOS launcher
├── start-linux.sh        Linux / Raspberry Pi launcher
├── README-FIRST.txt      Plain-text instructions for whoever finds the stick
├── server/
│   ├── server.js         Entry point: HTTP servers, routing, lifecycle
│   ├── config.default.json
│   └── lib/
│       ├── api.js        Admin JSON API and panel assets
│       ├── auth.js       scrypt passwords, sessions, login throttling
│       ├── config.js     Load, validate, atomically save settings
│       ├── ddns.js       Dynamic DNS providers
│       ├── http.js       Request/response helpers
│       ├── log.js        Console + rotating file logs
│       ├── mime.js       Content types
│       ├── safepath.js   Path-traversal containment
│       └── static.js     Static file serving
├── admin/                The management UI (HTML/CSS/JS, no build step)
├── site/                 ← YOUR WEBSITE. Everything here is published.
└── data/                 Created at runtime: config, users, sessions, logs
docs/                     The guides listed above
tools/
├── smoke-test.sh         48-check end-to-end test of the running server
└── install-service.sh    Install as a systemd service so it survives reboots
```

## Requirements

- **Node.js 18 or newer** on the host machine (Node 20 LTS or 22 LTS
  recommended). Nothing else — no npm packages are used or downloaded.
- A USB stick of any size. FAT32, exFAT and ext4 all work.

## Testing

```bash
tools/smoke-test.sh          # starts a server on port 18080 and checks 48 behaviours
node usb/server/server.js --check   # validate configuration without starting
```

The smoke test uses a throwaway data directory and restores anything it moved,
so it is safe to run against a working install.

## Licence

MIT — see [LICENSE](LICENSE).
