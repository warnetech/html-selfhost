# 3 — Going online

A domain name, an address that follows your connection, and HTTPS.

---

## The problem with a home connection

Telstra gives residential services a **dynamic** public IP address. It is a real
public address — good — but it changes whenever the modem reconnects, which
happens after outages, firmware updates, and sometimes for no visible reason.
A domain pointed at today's address stops working next week.

Three ways to deal with that, in increasing order of capability:

| Option | Cost | Works behind CGNAT | HTTPS |
|---|---|---|---|
| 1. Dynamic DNS + free subdomain | free | no | manual |
| 2. Dynamic DNS + your own domain | ~$15/yr | no | manual |
| 3. Cloudflare Tunnel | free | **yes** | automatic |

If you are on Telstra 4G/5G Home Internet, or your modem's WAN IP starts with
`100.64.`–`100.127.`, only option 3 will work.

---

## Option 1 — Free subdomain with DuckDNS

The fastest route to a working address.

1. Go to <https://www.duckdns.org> and sign in with any of the offered
   accounts.
2. Create a subdomain, e.g. `mysite` → gives you `mysite.duckdns.org`.
3. Copy your account **token** from the top of the page.
4. In the admin panel: **Settings → Dynamic DNS**
   - Tick **Keep a domain name pointed at this connection**
   - Provider: **DuckDNS**
   - Subdomain: `mysite`
   - Token: paste it
   - Save.
5. Go to **Dashboard → Dynamic DNS → Update DNS now**. It should report
   `mysite.duckdns.org -> 203.0.113.42`.

The server re-checks every 15 minutes from then on and only sends an update
when the address has actually changed.

Your site is now at `http://mysite.duckdns.org/` (assuming external port 80 is
forwarded, per [guide 02](02-telstra-router-setup.md#step-2--forward-a-port-on-the-modem)).

---

## Option 2 — Your own domain via Cloudflare

Nicer address, and it sets you up for free HTTPS.

1. Buy a domain anywhere (Cloudflare Registrar, Namecheap, VentraIP…).
2. Add the domain to a free Cloudflare account and switch its nameservers to
   the two Cloudflare gives you.
3. Create an API token at
   **My Profile → API Tokens → Create Token → Edit zone DNS**, scoped to just
   this zone.
4. Copy the **Zone ID** from the domain's overview page.
5. In the admin panel: **Settings → Dynamic DNS**
   - Provider: **Cloudflare**
   - API token, Zone ID
   - Record name: `www.example.com` (or `example.com` for the bare domain)
   - Leave **Proxy through Cloudflare** off for now — turn it on once the
     direct connection is confirmed working.
   - Save, then **Update DNS now**.

The record is created if it does not exist, and updated in place if it does.

### Any other provider

No-IP, Dynu, afraid.org, Namecheap and most others accept a plain HTTP GET to
update a record. Choose provider **Generic update URL** and paste theirs, using
`{ip}` where the address goes:

```
https://dynupdate.no-ip.com/nic/update?hostname=me.ddns.net&myip={ip}
https://api.dynu.com/nic/update?hostname=me.dynu.net&myip={ip}
https://freedns.afraid.org/dynamic/update.php?YOUR_KEY
```

The URL must be `https://` — it carries your credentials, and the server
refuses plain HTTP for this reason.

---

## Option 3 — Cloudflare Tunnel (no port forwarding needed)

A tunnel makes an **outbound** connection from your host to Cloudflare, and
Cloudflare sends visitors down it. Nothing is forwarded, no port is opened, and
your home IP address is never exposed. This is the only option that works
behind CGNAT, and it gives you HTTPS for free.

```
Visitor ──https──► Cloudflare ──existing outbound tunnel──► your host:8080
```

### Setup

```bash
# Install cloudflared (Debian/Ubuntu/Raspberry Pi OS, 64-bit)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# Authenticate (opens a browser link)
cloudflared tunnel login

# Create the tunnel and point a hostname at your local server
cloudflared tunnel create mysite
cloudflared tunnel route dns mysite www.example.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: mysite
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: www.example.com
    service: http://localhost:8080
  - service: http_status:404
```

Run it as a service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Then adjust two settings in the admin panel

- **Settings → Server → Behind a reverse proxy or tunnel** — tick it. Without
  this, every visitor appears to come from `127.0.0.1`, which breaks the login
  rate limiter and makes the access log useless.
- **Settings → Security → Redirect HTTP to HTTPS** — tick it once the tunnel is
  confirmed working.

Leave dynamic DNS **off** when using a tunnel. Cloudflare manages the DNS record
itself, and a DDNS updater fighting it will break things.

---

## HTTPS

Browsers now mark plain `http://` as "Not secure", and some features
(clipboard, service workers, geolocation) refuse to run without TLS.

**The easy path is Cloudflare Tunnel above** — TLS is terminated by Cloudflare
and you do nothing.

### Let's Encrypt with Caddy

If you have a real public IP and want to terminate TLS yourself, put Caddy in
front. It obtains and renews certificates automatically.

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
www.example.com {
    reverse_proxy localhost:8080
}
```

```bash
sudo systemctl reload caddy
```

Forward **both** ports on the modem: external `80 → 80` and `443 → 443`, both
to the host. Caddy needs port 80 for the ACME HTTP-01 challenge and will
redirect it to HTTPS afterwards.

Then in the admin panel tick **Behind a reverse proxy or tunnel** and
**Redirect HTTP to HTTPS**.

> This server speaks HTTP only, by design. TLS certificate handling, renewal
> and cipher configuration are a large surface area to get wrong, and Caddy and
> Cloudflare already do it properly. Put one of them in front rather than
> asking a USB stick to manage certificates.

---

## Managing the site remotely

Once the site is public, the admin panel is public too, at
`https://www.example.com/__admin`. That is the point — you can edit your site
from a phone on the other side of the world.

It is also the single most attacked thing you now own. Before you leave it
exposed, read [05 — Security](05-security.md). At minimum:

- Change the admin password to something long and unique.
- Change the admin path from `/__admin` to something unguessable.
- Consider ticking **Local network only** and reaching the panel over a VPN
  (Tailscale or WireGuard) instead of exposing it at all.

---

**Next:** [04 — Admin panel](04-admin-panel.md).
