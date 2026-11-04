# 1 — Quick start

From an empty USB stick to a working website on your network.

---

## Step 1 — Choose the host machine

The Telstra modem cannot run the server ([why](02-telstra-router-setup.md#why-the-modem-cannot-do-this-itself)),
so you need one small computer that stays switched on. Anything that runs
Node.js 18+ will do:

- **Raspberry Pi Zero 2 W / Pi 4 / Pi 5** — the usual choice. Silent, ~1–4 W.
- **An old laptop** — free, and the battery is a built-in UPS. Disable sleep
  and set it to stay on with the lid closed.
- **A mini PC or thin client** — quiet, reliable, cheap secondhand.
- **A desktop you already leave on** — fine, but the site is down whenever the
  desktop is.

Plug it into the modem with an Ethernet cable if you can. Wi-Fi works, but a
cable removes a whole category of "why did the site go down overnight".

## Step 2 — Install Node.js on the host

```bash
# Raspberry Pi OS / Debian / Ubuntu
sudo apt update && sudo apt install -y nodejs

# Check the version — it must be 18 or newer
node --version
```

If `apt` gives you something older than 18, use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

On **Windows** and **macOS**, download the LTS installer from
<https://nodejs.org/>.

> **Offline host?** You can also drop a portable Node build on the stick itself
> as `runtime/bin/node` (Linux/macOS) or `runtime\node.exe` (Windows). The
> launchers check there first, so the stick stays entirely self-contained.

## Step 3 — Prepare the USB stick

Copy the **contents** of the `usb/` folder to the root of the stick — not the
folder itself. The stick should end up looking like this:

```
E:\  (or /media/you/MYSTICK/)
├── START-WINDOWS.bat
├── START-MAC.command
├── start-linux.sh
├── README-FIRST.txt
├── server/
├── admin/
└── site/
```

```bash
# Linux / macOS
cp -r usb/. /media/you/MYSTICK/

# Windows PowerShell
Copy-Item -Recurse .\usb\* E:\
```

Any filesystem works. FAT32 caps single files at 4 GB and cannot store Unix
permissions — fine for a website, and the server is written to cope with it.

## Step 4 — First run

Plug the stick into the host and start the server.

```bash
cd /media/you/MYSTICK
./start-linux.sh
```

On Windows, double-click `START-WINDOWS.bat`. On macOS, double-click
`START-MAC.command` (the first time, you may need to right-click → Open to get
past Gatekeeper).

You will see:

```
  Self-Host Starter v1.0.0
  ────────────────────────────────────────────────────
  Serving   /media/you/MYSTICK/site
  Local     http://localhost:8080/
  LAN       http://192.168.0.42:8080/   (eth0)
  Admin     http://192.168.0.42:8080/__admin
  ────────────────────────────────────────────────────

  FIRST RUN — an admin account was created:

      username: admin
      password: Mdjvd-xiwz9-EUV4a-sqTR2

  Sign in and change it now. It is also saved to
  data/FIRST-RUN-PASSWORD.txt — delete that file afterwards.
```

Write the LAN address down — you need it for port forwarding later.

## Step 5 — Check it from another device

On your phone or laptop, on the same Wi-Fi, open the LAN address
(`http://192.168.0.42:8080/`). You should see the starter page.

If it does not load, the host's own firewall is the usual culprit:

```bash
sudo ufw allow 8080/tcp          # Ubuntu / Debian
sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload   # Fedora
```

On Windows, allow Node.js through Windows Defender Firewall when prompted —
tick **Private networks**.

## Step 6 — Sign in and secure the panel

1. Open `http://<LAN-address>:8080/__admin`
2. Sign in as `admin` with the generated password.
3. Go to **Settings → Change admin password** and set your own. This signs out
   every device, which is the point.
4. Delete `data/FIRST-RUN-PASSWORD.txt` from the stick.

## Step 7 — Put your own site on it

Everything in `site/` is published exactly as it sits on disk. Either:

- Use the admin panel's **Files** tab to edit `index.html` in the browser and
  upload images, or
- Copy an existing static site into `site/` on the stick — a Hugo/Jekyll/Astro
  build output, an exported site, plain HTML, whatever. It will just work.

## Step 8 — Keep it running

Right now the server stops when you close the terminal. On Linux, install it as
a service so it starts at boot and restarts if it crashes:

```bash
sudo tools/install-service.sh /media/you/MYSTICK
```

Then:

```bash
sudo systemctl status selfhost     # is it running?
sudo journalctl -u selfhost -f     # live logs
```

On Windows, put a shortcut to `START-WINDOWS.bat` in
`shell:startup` (Win+R → type `shell:startup`). On macOS, add
`START-MAC.command` to **System Settings → General → Login Items**.

---

**Next:** [02 — Telstra router setup](02-telstra-router-setup.md) to make the
site reachable from the internet.
