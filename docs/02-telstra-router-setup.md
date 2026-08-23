# 2 — Telstra router setup

Making your site reachable from the internet through a Telstra Smart Modem.

---

## Why the modem cannot do this itself

Every generation of the Telstra Smart Modem has a USB port, and every
generation uses it for the same two things:

- **SMB / Windows file sharing** — the drive appears on your LAN as a network
  folder.
- **DLNA media streaming** — smart TVs can browse video on it.

That is the whole feature. The firmware is locked: there is no SSH, no shell,
no package manager, no init hook, and no supported way to run your own program
on the modem. It cannot execute a web server, and it will not run one from a
USB stick no matter how the stick is laid out.

This is true of:

| Model | Marketing name |
|---|---|
| Technicolor DJA0230 / DJA0231 | Telstra Smart Modem Gen 2 |
| Sagemcom F@ST 5355 | Telstra Smart Modem Gen 2 |
| Sagemcom F@ST 5366TN | Telstra Smart Modem Gen 3 |
| Telstra Frontier / Smart Modem Gen 3 | Gen 3 |

So the modem does what it is actually good at — holding a public IP address and
forwarding connections — and a small machine on your LAN runs the server.

---

## Step 1 — Give the host machine a fixed LAN address

Port forwarding sends traffic to an IP address. If the host's address changes
after a reboot, the forward silently breaks. Fix the address first.

### The easy way: a DHCP reservation on the modem

1. Find the host's MAC address:
   ```bash
   ip link show          # Linux — look for "link/ether"
   ipconfig /all         # Windows — "Physical Address"
   ```
2. Browse to **`http://192.168.0.1`** (Telstra's default gateway — not
   `192.168.1.1`).
3. Sign in. The admin password is printed on the label on the base or back of
   the modem. If it has been changed and you do not know it, hold the reset pin
   for 10 seconds — note that this wipes your Wi-Fi settings too.
4. Find the connected-devices list. Depending on model this is under
   **Devices**, **My Network**, or **Home Network**.
5. Select the host machine and turn on **Reserve IP address** / **Static
   lease** / **Always use this IP**.

### Or set it on the host

On Raspberry Pi OS / Ubuntu with NetworkManager:

```bash
nmcli con mod "Wired connection 1" \
  ipv4.addresses 192.168.0.42/24 \
  ipv4.gateway 192.168.0.1 \
  ipv4.dns "192.168.0.1,1.1.1.1" \
  ipv4.method manual
sudo nmcli con up "Wired connection 1"
```

Pick an address outside the modem's DHCP pool — on Telstra modems the pool
usually starts at `.20` or `.100`, so something like `192.168.0.10` is safe.

Confirm the site is reachable at `http://192.168.0.42:8080/` from another
device before continuing.

---

## Step 2 — Forward a port on the modem

1. Sign in to `http://192.168.0.1`.
2. Find port forwarding:
   - **Gen 2 (Technicolor DJA0231):** Advanced → **Firewall** → Port Forwarding,
     or Advanced → **NAT** → Port Forwarding.
   - **Gen 2 (Sagemcom F@ST 5355):** Advanced Settings → **NAT** → Port
     Forwarding / Virtual Servers.
   - **Gen 3 (Sagemcom F@ST 5366):** Advanced Settings → **Port Forwarding**.
3. Add a rule:

   | Field | Value |
   |---|---|
   | Name / Description | `website` |
   | Protocol | TCP |
   | External / WAN port | `80` |
   | Internal / LAN port | `8080` |
   | Internal IP / Device | `192.168.0.42` (your host) |
   | Enabled | yes |

4. Save and apply. Some models restart the firewall and drop connections for a
   few seconds.

Add a second rule for `443 → 8443` later if you set up HTTPS
([guide 03](03-going-online.md#https)).

### Why not just run the server on port 80 directly?

You can, but on Linux ports below 1024 need root, and running a network-facing
server as root is a bad trade for saving one forwarding rule. Forwarding
external 80 to internal 8080 gives visitors a clean `http://yoursite/` URL with
the server running as an ordinary user.

If you would rather bind port 80 directly:

```bash
# Grant just this one capability to the node binary
sudo setcap CAP_NET_BIND_SERVICE=+eip "$(readlink -f "$(which node)")"
```

---

## Step 3 — Find your public address

In the modem UI, look for **WAN IP** or **Internet IP** on the status page. Or
from the host:

```bash
curl -s https://api.ipify.org; echo
```

Compare the two. They should match.

**If the modem's WAN IP starts with `100.64.` through `100.127.`, you are
behind CGNAT** — carrier-grade NAT — and port forwarding cannot work no matter
how you configure it. Skip to
[Cloudflare Tunnel](03-going-online.md#option-3--cloudflare-tunnel-no-port-forwarding-needed).

On Telstra:

- **NBN and other fixed-line plans** normally get a real public IPv4 address
  (dynamic — it changes on reconnect) plus IPv6. Port forwarding works.
- **Telstra 4G/5G Home Internet** is behind CGNAT. Port forwarding will not
  work; use a tunnel.
- A **static IP** is available as a paid add-on if you want the address to stop
  moving. It is not required — dynamic DNS solves the same problem for free.

---

## Step 4 — Test from outside

**Test from mobile data with Wi-Fi turned off**, not from your own network.
Many modems do not support NAT hairpinning, so your public address often fails
from inside the house even when it works perfectly from outside.

```
http://<your-public-ip>/
```

If that loads your site, the hard part is done. Continue to
[03 — Going online](03-going-online.md) to attach a domain name.

---

## Option B — Keep the stick in the modem

If you specifically want the USB stick plugged into the Telstra modem, you can
have that. The modem stores and shares the files; the host machine mounts that
share and serves it.

```
   USB stick ──► Telstra modem ──SMB over LAN──► host running server.js ──► visitors
```

**Trade-offs, honestly:** the modem's SMB implementation is slow, often
SMB1-only, and drops the share when the modem reboots. Every page request now
depends on a network hop. It works, and it is genuinely "the router holds the
website", but a stick plugged straight into the host is faster and far more
reliable. Use this only if the modem-hosted stick is the point.

### 1. Enable file sharing on the modem

Plug the stick in, sign in to `http://192.168.0.1`, and look under
**USB** / **Storage** / **Content Sharing**. Enable **File sharing (SMB)**. Note
the share name the modem gives it — often `USB1_1`, `usb`, or the drive's
volume label.

### 2. Mount the share on the host

```bash
sudo apt install -y cifs-utils
sudo mkdir -p /mnt/routerusb
```

Telstra modems commonly speak only SMB1, which modern Linux refuses by default.
Try the modern dialect first and fall back:

```bash
# Try this first
sudo mount -t cifs //192.168.0.1/USB1_1 /mnt/routerusb \
  -o guest,uid=$(id -u),gid=$(id -g),vers=3.0,ro

# If that fails with "mount error(112)" or "Host is down", the modem is SMB1
sudo mount -t cifs //192.168.0.1/USB1_1 /mnt/routerusb \
  -o guest,uid=$(id -u),gid=$(id -g),vers=1.0,sec=ntlm,ro
```

Drop the `ro` if you want the admin panel to be able to write back to the
stick. Keep it read-only if you will edit the stick by unplugging it.

Make it survive reboots by adding to `/etc/fstab`:

```
//192.168.0.1/USB1_1  /mnt/routerusb  cifs  guest,uid=1000,gid=1000,vers=1.0,sec=ntlm,_netdev,nofail,x-systemd.automount  0  0
```

`nofail` and `_netdev` matter: without them the host will hang at boot if the
modem is not ready yet.

### 3. Point the server at the mounted share

In the admin panel, **Settings → Website → Site folder**, set it to the
absolute path of the site directory on the share:

```
/mnt/routerusb/site
```

Or edit `data/config.json` directly:

```json
{ "site": { "root": "/mnt/routerusb/site" } }
```

Restart the server. It now serves the website straight off the USB stick that
is plugged into the Telstra modem.

> **SMB1 is an insecure protocol.** Only enable it on a LAN you control, never
> expose port 445 through the modem, and do not use this arrangement on a
> shared or public network.

---

## Option C — Bridge mode and your own router

If you run the Telstra modem in bridge mode behind your own router (a Ubiquiti,
Mikrotik, OPNsense box, or similar), ignore the Telstra UI entirely and set the
port forward on your own router. Everything else in these guides applies
unchanged.

---

**Next:** [03 — Going online](03-going-online.md) — domain names, dynamic DNS
and HTTPS.
