# Two apps, one Pi — Book Recs + Classroom Library with two DuckDNS sites

Run [Classroom-book-recs](../README.md) and
[classroomlib](https://github.com/mob5824m-wq/classroomlib) on the **same
Raspberry Pi 4**, each on its **own DuckDNS hostname** with free HTTPS:

| App | Public URL | On the Pi |
|-----|-----------|-----------|
| 📚 Book Recs | `https://mybookrecs.duckdns.org` | `localhost:8080` |
| 🏫 Classroom Library | `https://myroomlibrary.duckdns.org` | `localhost:8081` |

(Replace `mybookrecs` / `myroomlibrary` with your real DuckDNS subdomains.)

## How it fits together

```
Students at school
   |  https://mybookrecs.duckdns.org      https://myroomlibrary.duckdns.org
   |           (both point at your ONE home IP — two hostnames, one Pi)
   v
 Router forwards 443 -> Pi:443  and  80 -> Pi:80
   v
 ONE Caddy (owns 443+80, two free Let's Encrypt certs, routes by hostname)
   |  mybookrecs...     reverse_proxy localhost:8080
   |  myroomlibrary...  reverse_proxy localhost:8081
   v                    v
 node server.js       node server.js
 Book Recs :8080      Classroom Library :8081
 (bookrecs-data.json) (library-data.json — separate files, separate data)
```

Only **one** thing on the Pi may bind port 443 — that's the single shared
Caddy. The apps themselves never touch 443; they just listen on different
localhost ports. On the home LAN both stay reachable directly too:
`http://<pi-ip>:8080` (Book Recs) and `http://<pi-ip>:8081` (Library).

## The contract (canonical — classroomlib adapts to this)

| | Book Recs (this repo) | Classroom Library |
|---|---|---|
| Port | **8080** | **8081** |
| Port pin (env beats everything else) | `BOOKRECS_PORT=8080` | `CLASSROOM_PORT=8081` |
| systemd unit | `book-recs.service` → `book-recs` | `classroom-library.service` → `classroom-library` |
| Folder | `/home/pi/Classroom-book-recs` | `/home/pi/classroomlib` |
| Caddy `reverse_proxy` target | `localhost:8080` | `localhost:8081` |

The ports are pinned in the systemd units on purpose: Book Recs also has a
*saved admin port setting*, but env wins over it (`--port` flag →
`PORT`/`BOOKRECS_PORT` env → saved setting → `8080`), so a port change in the
admin UI can never silently collide with the other app. Standalone installs
are unaffected — each app still defaults to 8080 when the pin isn't set.

Nothing else can clash: session cookies (`bookrecs_session` vs
`classroom_session`), data files (`bookrecs-data.json` vs
`library-data.json`), secret keys and session stores all have different names.

## Setup, step by step

Do this **once**, on the Pi, in this order.

### 1. Folders — clone both repos side by side

```bash
cd /home/pi
git clone https://github.com/mob5824m-wq/Classroom-book-recs.git
git clone https://github.com/mob5824m-wq/classroomlib.git
```

Each app keeps its own data, sessions and secret key inside its own folder —
back up **both** folders' `*-data.json` + `*-secret.key` files.

### 2. DuckDNS — two hostnames, one updater, one cron line

1. At https://www.duckdns.org create **two** subdomains (e.g. `mybookrecs`
   and `myroomlibrary`) and note your **token** (top of the DuckDNS page).
2. In **this** repo only:
   ```bash
   cd /home/pi/Classroom-book-recs
   cp deploy/duckdns.conf.example deploy/duckdns.conf
   # edit deploy/duckdns.conf:
   #   DUCKDNS_DOMAINS=mybookrecs,myroomlibrary
   #   DUCKDNS_TOKEN=your-token-here
   ./deploy/duckdns-update.sh   # should print "DuckDNS update OK (...)"
   ```
3. One cron entry updates **both** hostnames (DuckDNS accepts a
   comma-separated list — `crontab -e`):
   ```
   */5 * * * * /home/pi/Classroom-book-recs/deploy/duckdns-update.sh >>/home/pi/duckdns.log 2>&1
   ```
   Do **not** also run classroomlib's updater — one updater, one cron line.
   (If your router can update DuckDNS itself, list both hostnames there and
   skip the script entirely.)

### 3. The apps — one systemd service each, ports pinned

Book Recs (port pinned to 8080 inside the unit file):

```bash
sudo cp /home/pi/Classroom-book-recs/deploy/book-recs.service /etc/systemd/system/
```

Classroom Library (its unit pins `CLASSROOM_PORT=8081`):

```bash
sudo cp /home/pi/classroomlib/deploy/classroom-library.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now book-recs classroom-library
```

Check both:

```bash
systemctl status book-recs classroom-library --no-pager
curl -s http://localhost:8080/api/state >/dev/null && echo "book-recs OK (:8080)"
curl -s http://localhost:8081/api/state >/dev/null && echo "classroomlib OK (:8081)"
```

### 4. Caddy — ONE instance serving both hostnames

Install Caddy once (https://caddyserver.com/download — the Debian/Raspbian
`apt` package is easiest; it also installs a `caddy` systemd service), then
give it the **shared** config from this repo:

```bash
sudo cp /home/pi/Classroom-book-recs/Caddyfile.dual.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # put in your TWO real DuckDNS hostnames
sudo caddy fmt --overwrite /etc/caddy/Caddyfile   # optional: tidy + validate
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
```

Do **not** also run classroomlib's single-site `Caddyfile.example` — only one
Caddy may own port 443. (Running Caddy by hand instead of as a service?
`cd /home/pi/Classroom-book-recs && cp Caddyfile.dual.example Caddyfile`,
edit it, `caddy run`.)

### 5. Router — forward 80 and 443 to the Pi

- Give the Pi a **static LAN IP** (DHCP reservation by MAC address in the
  router, e.g. `192.168.1.50`).
- Forward **external 443 → `192.168.1.50`:443** and
  **external 80 → `192.168.1.50`:80**. Port 80 is how Let's Encrypt
  certificates are issued/renewed; without it the first certificate may never
  arrive. (If your ISP uses carrier-grade NAT you can't forward ports at
  all — then this whole setup can't work and you need the Cloudflare Tunnel
  option in [HOSTING.md](../HOSTING.md) instead.)

### 6. Firewall on the Pi — LAN access to both apps

```bash
sudo ufw allow 80,443/tcp      # Caddy (public HTTPS)
sudo ufw allow 8080,8081/tcp   # direct LAN access to each app
```

### 7. Test

- On the Pi: the two `curl` checks from step 3.
- On home Wi-Fi: `http://<pi-ip>:8080` → Book Recs,
  `http://<pi-ip>:8081` → Library.
- From outside (phone on mobile data, **not** home Wi-Fi):
  `https://mybookrecs.duckdns.org` and `https://myroomlibrary.duckdns.org`.
  First visit can take ~30 s while Caddy fetches the certificates — that's
  normal. `sudo journalctl -u caddy -f` shows what it's doing.

## Day-to-day

| Task | Command |
|------|---------|
| Both running? | `systemctl status book-recs classroom-library caddy --no-pager` |
| App logs | `journalctl -u book-recs -f` / `journalctl -u classroom-library -f` |
| Caddy / cert logs | `journalctl -u caddy -f` |
| Update an app | `cd <repo> && git pull && sudo systemctl restart <service>` |
| Why can't LAN devices reach an app? | `node deploy/lan-check.js --port=8080` (or `--port=8081` from the other repo) |
| Backups | copy `bookrecs-data.json` + `bookrecs-secret.key` **and** `library-data.json` + `library-secret.key` somewhere safe |

## Troubleshooting

| Symptom | Cause → fix |
|---------|-------------|
| `EADDRINUSE` / one app won't start | Both tried the same port — check the service pins: `systemctl cat book-recs \| grep PORT` must say `8080`, `systemctl cat classroom-library \| grep PORT` must say `8081`. Then `sudo systemctl daemon-reload` + restart. |
| Wrong app answers on a port | Same as above — `curl -s http://localhost:8080/ \| head -c 200` tells you who's actually listening. |
| `bind: address already in use` from Caddy on 443 | A second Caddy (or something else) already owns 443 — `sudo lsof -i :443 -sTCP:LISTEN`. Only one Caddy may run. |
| `https://…` shows Caddy `404` / blank | Hostname in `/etc/caddy/Caddyfile` doesn't match what you typed — `sudo caddy validate --config /etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`. |
| Certificate never issued / TLS error | Port 80 not forwarded, or DuckDNS still points at an old IP — `./deploy/duckdns-update.sh`, wait 1–2 min, `nslookup mybookrecs.duckdns.org`, compare with your public IP. |
| One DuckDNS site works, the other doesn't | The updater only knows one hostname — `duckdns.conf` must list **both** comma-separated; check `/home/pi/duckdns.log`. |
| Works on the Pi, not on other LAN devices | Firewall (`sudo ufw allow 8080,8081/tcp`), or devices on guest Wi-Fi / another VLAN. `node deploy/lan-check.js --port=808X` diagnoses it. |
| Works at home, fails at school | Expected for `http://192.168…` LAN URLs — they only work on the home network. From school, always use the `https://….duckdns.org` URLs. |

## What classroomlib must do (for the other repo)

This repo defines the contract; classroomlib mirrors it:

1. **Port 8081 when co-hosted** — its `deploy/classroom-library.service`
   pins `Environment=CLASSROOM_PORT=8081` (its server already honors
   `PORT`/`CLASSROOM_PORT`, default stays 8080 for standalone installs).
2. **DuckDNS updater accepts `DUCKDNS_DOMAINS`** (comma-separated, same as
   this repo's script) — but its docs must say: when co-hosted, run the
   updater from ONE repo only.
3. **No own Caddy when co-hosted** — its single-site `Caddyfile.example`
   stays for standalone use; its docs point here
   (`Classroom-book-recs/Caddyfile.dual.example`) as the shared config.
4. **Docs** — its HOSTING/deploy notes link to this file as the canonical
   dual-host guide.

Already fine without changes: cookie name (`classroom_session` ≠
`bookrecs_session`), data/secret/session filenames, and systemd unit name.
