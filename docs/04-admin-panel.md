# 4 — The admin panel

Everything you can do from a browser, on any device.

The panel lives at `<your-site>/__admin` (configurable). It is a single HTML
page with no build step and no external dependencies, so it loads fast over a
slow home upload link and works offline on the LAN.

---

## Signing in

Username and password only — no email, no recovery link, no third party. The
account is stored on the stick in `data/users.json` as an scrypt hash.

After five failed attempts from one IP address, that address is locked out for
15 minutes. Each further failure doubles the lockout, up to an hour. Both
numbers are configurable under **Settings → Security**.

**Lost the password?** There is no reset link by design. Delete
`data/users.json` from the stick and restart the server — it generates a fresh
`admin` account and prints the new password.

---

## Dashboard

| Card | Meaning |
|---|---|
| Uptime | How long this server process has been running |
| Requests served | Total requests and bytes sent since start |
| Site content | File count and total size of the `site/` folder |
| Errors | Server-side errors logged; anything above 0 is worth checking in the error log |
| Free space | Remaining space on the USB stick |
| Host | Machine name, OS, Node version |

**Reaching this site from the internet** shows your LAN address, the public
address (once dynamic DNS has detected it) and the port-forwarding rule you
need on the modem.

**Dynamic DNS** shows provider status, the last detected address, and when it
last ran. **Update DNS now** forces an immediate update, skipping the
"has the address actually changed?" check — useful right after you enter
credentials.

---

## Files

The left pane is your `site/` folder. The right pane is a text editor.

**Editing.** Click any text file — HTML, CSS, JS, JSON, Markdown, SVG, TXT,
XML, YAML, CSV — and it opens in the editor. **Save** writes it, or press
**Ctrl+S** / **Cmd+S**. An "Unsaved" pill appears the moment you type, and the
browser warns you if you try to navigate away with unsaved work.

Saves are atomic: the content is written to a temporary file and renamed into
place. A browser that dies mid-save cannot leave a half-written `index.html`
serving to the public.

**Uploading.** Drag files onto the file pane, or use **Upload**. If a folder is
selected, files land inside it. Any file type is accepted up to the size limit
(50 MB by default, under **Settings → Server**).

**Creating.** **New file** and **New folder** prompt for a path relative to the
site folder, so `blog/2026/post.html` creates the intermediate folders for you.
New `.html` files are pre-filled with a working page skeleton.

**Per-file actions**, on hover:

| Icon | Action |
|---|---|
| ⭳ | Download the file |
| ✎ | Rename or move it (type a new path) |
| ✕ | Delete it — non-empty folders require an explicit confirmation |

**Preview ↗** opens the file on the live public site in a new tab.

### What cannot be edited here

Binary files (images, video, PDFs, fonts) can be uploaded, downloaded, renamed
and deleted, but not opened in the text editor. Text files above 2 MB are also
refused — edit those offline and upload them.

The panel can only ever touch the `site/` folder. Paths containing `..`,
absolute paths, drive letters and symlinks pointing outside the folder are all
rejected before anything is opened.

---

## Settings

Changes take effect immediately, except the listening ports — the panel tells
you when a restart is needed.

**Website** — which folder to publish, the index and 404 filenames, clean URLs
(`/about` serves `about.html`), and whether folders without an index page show
a file listing.

The **Site folder** field is how you serve files from somewhere other than the
stick — for example `/mnt/routerusb/site` to read straight off the USB drive
plugged into the Telstra modem
([Option B](02-telstra-router-setup.md#option-b--keep-the-stick-in-the-modem)).

**Server** — ports, bind address, upload limit, gzip. Set **Separate admin
port** if you want the panel on a different port from the public site, so you
can forward one and not the other. Tick **Behind a reverse proxy or tunnel**
whenever Caddy, nginx or Cloudflare Tunnel sits in front, so client IP
addresses are read from `X-Forwarded-For`.

**Admin panel** — rename the URL path, set session length, and restrict the
panel to the local network.

**Security** — HTTPS redirect, HSTS, login lockout thresholds, and the
Content-Security-Policy sent with your public pages. If your site loads fonts,
scripts or images from other domains, you will need to widen that policy.

**Dynamic DNS** — see [guide 03](03-going-online.md). Saved tokens are shown as
`••••••••` and are never sent back to the browser; leaving the bullets in place
keeps the stored value.

**Logging** — turn the access log on or off, and set the size at which it
rotates.

---

## Logs

Tail the access log or the error log, 100–1000 lines at a time.

Access log format:

```
2026-08-23T07:14:02.118Z 203.0.113.9 GET /about 200 1483 3ms "-" "Mozilla/5.0 …"
```

`timestamp  client-ip  method  path  status  bytes  duration  referer  user-agent`

Logs rotate to `.1` when they hit the configured size — 5 MB by default — so
they cannot fill the stick.

---

## Using it from a phone

The layout collapses to a single column below 860 px. The file tree, editor,
settings and logs all work on a phone; the ☰ button reveals the tabs. Editing
HTML on a phone keyboard is not fun, but fixing a typo or uploading a photo
from the couch works fine.

---

**Next:** [05 — Security](05-security.md).
