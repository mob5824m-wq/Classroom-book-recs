# Hosting your Classroom Book Recs at home (usable at school)

This guide shows you how to serve the Classroom Book Recs from a computer in your
home and reach it from school through a **dynamic DNS** (DDNS) address.

---

## Option A — Cloudflare Tunnel (easiest, recommended)

**No port forwarding. No router changes. Free automatic HTTPS.** Cloudflare
connects from your home computer *outward* to their edge, so you don't open any
ports on your router — this is the most beginner-friendly and reliable option,
and it works even if your school filters many sites (Cloudflare domains are
usually allowed).

### 1. Start the server
```bash
# from the Classroom-book-recs folder
node server.js
```
Confirm it prints `Server running on http://0.0.0.0:8080`.

### 2. Install & set up cloudflared (free)
- **Windows:** download `cloudflared-windows-amd64.exe` from
 https://github.com/cloudflare/cloudflared/releases and save it to a folder.
- **macOS:** `brew install cloudflared`
- **Linux / Raspberry Pi:** `sudo apt install cloudflared` (or download the
 `.deb`/binary from the releases page).

### 3. Create your free domain
1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up
2. Go to **Zero Trust → Networks → Tunnels → Create a tunnel**.
3. Choose **Cloudflared**, name it (e.g. `bookrecs`), and follow the on-screen
 "Install and run a connector" instructions.
4. Under **Public Hostname**, add a hostname such as:
 - Subdomain: `bookrecs`, Domain: the one Cloudflare gives you.
5. **Service:** set `Type = HTTP`, `URL = localhost:8080`.
6. Cloudflare shows you your public URL — **that URL is now your site's address, with HTTPS built in.**

### 4. Share it with the school
Give the teacher(s) the public `https://…` URL. Open it at school.

> The free Tunnel URL already updates automatically if your home IP changes,
> so there's no separate DDNS account to maintain.

---

## Option B — Classic dynamic DNS (DuckDNS / No-IP) + HTTPS

Use this if you prefer your own hostname and are comfortable opening a port on
your home router.

### 1. Pick a DDNS provider & get a hostname
- **DuckDNS** (free, simple): https://www.duckdns.org — create a subdomain like
 `mybookrecs.duckdns.org`. Install their tiny update client, or set your
 router to auto-update DuckDNS (many routers support it).
- **No-IP** (free hostname, must refresh monthly): https://www.noip.com
- **FreeDNS** (free): https://freedns.afraid.org

Your DDNS hostname stays the same even though your home IP changes.

### DuckDNS step-by-step (recommended)

1. **Create your hostname** — go to https://www.duckdns.org and sign in with a
   Google/GitHub/Twitter account. Add a subdomain (e.g. `mybookrecs`) so your
   address is `mybookrecs.duckdns.org`. Write down your **token** from the
   DuckDNS dashboard — you'll need it for automatic updates.

2. **Install the DuckDNS update client** so your hostname always points to your
   current home IP. Ready-to-run files are in the `deploy/` folder:
   - **Linux / Raspberry Pi:** `cp deploy/duckdns.conf.example deploy/duckdns.conf`,
     fill in your domain + token, test with `./deploy/duckdns-update.sh`, then add
     this to `crontab -e` (adjust the path):
     ```
     */5 * * * * /home/pi/Classroom-book-recs/deploy/duckdns-update.sh >>/home/pi/duckdns.log 2>&1
     ```
   - **Windows:** edit `deploy/duckdns-update.bat` with your domain + token, run
     it once, then create a scheduled task (instructions inside the file).
   - **Router-based:** many routers (ASUS, TP-Link, etc.) support DuckDNS
     directly in their DDNS settings — easiest option, no extra software.

3. **Give your computer a static LAN IP** (so port-forwarding never breaks):
   in your router, reserve an IP like `192.168.1.50` for your computer's MAC address.

4. **Open a port on your router** — forward **external 443 → 192.168.1.50:443**
   (Caddy listens on the standard HTTPS port). If port 443 is already used on
   that computer, use the `:8443` alternative in `Caddyfile.example` and forward
   external 443 → internal 8443 instead. If your ISP uses carrier-grade NAT you
   won't be able to forward ports — switch to the Cloudflare Tunnel option.

5. **Run Caddy to get free HTTPS**:
   - Install Caddy from https://caddyserver.com/download
   - Rename the included `Caddyfile.example` to `Caddyfile` and put your
     DuckDNS hostname in it (e.g. `mybookrecs.duckdns.org`).
   - Run `caddy run`. Caddy auto-fetches and renews your Let's Encrypt
     certificate and routes HTTPS to the app on port `8080`.

6. **Start the app** (`node server.js`) and confirm it prints
   `Server running on 0.0.0.0:8080`. To keep it running automatically, use
   `deploy/book-recs.service` (Linux/systemd) or
   `deploy/start_bookrecs.bat` (Windows) — see below.

7. **Test from outside your home** — on a phone's data (not your Wi-Fi), open
   `https://mybookrecs.duckdns.org`. If it loads, you're live.

### Port model (the app always listens on 0.0.0.0:8080)

```
Students at school
   |  https://mybookrecs.duckdns.org
   v
 Caddy (443)   <- router forwards external 443 here (or 8443 alternative)
   |  reverse_proxy localhost:8080
   v
 node server.js (0.0.0.0:8080)
```

- **Primary:** Caddy binds `443`, router forwards `443 → computer:443`.
- **Alternative (443 busy):** use the `:8443` block in `Caddyfile.example`,
  Caddy binds `8443`, router forwards `443 → computer:8443`.

---

## Running the server automatically (so it's always on)

Keep the server running so students can use it whenever they're at school.

### macOS (MacBook)
Run `bash deploy/setup-mac.sh` once — it installs Node + Caddy (via Homebrew,
if needed), fills in the paths, and loads **launchd agents** that start
on login and stay running.

### Windows
1. Edit `deploy/start_bookrecs.bat` to point `cd /d` at where you cloned the repo.
2. Press `Win + R`, type `shell:startup`, press Enter, and put a shortcut to
   `deploy/start_bookrecs.bat` there.
   The server starts automatically when you log in. (For a true service, install
   [NSSM](https://nssm.cc) and run `node server.js` as a Windows service.)

### Linux / Raspberry Pi (systemd)
A ready-to-run unit is included at `deploy/book-recs.service`. Edit the
paths in it, then:
```bash
sudo cp deploy/book-recs.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now book-recs
```
Check status / logs with `systemctl status book-recs` and
`journalctl -u book-recs -f`.

---

## LAN access without the internet (backup)
If the internet is down, the site still works **on your home Wi-Fi** at
`http://<your-computer's-LAN-IP>:8080` (e.g. `http://192.168.1.50:8080`).

---

## Important notes
- **Data is shared on the server.** The app runs on a real backend
  (`node server.js`) that keeps one shared `bookrecs-data.json`, so books,
  students, and questionnaires are the same on every device that connects.
- **Back up the data.** Copy `bookrecs-data.json` and `bookrecs-secret.key`
  somewhere safe (USB drive / network share).
- **Security is enforced server-side.** Students can only submit questionnaire
  responses — they can't change the catalog, classes, or accounts. Only the
  **admin** account can manage everything.
- **Protect the admin account.** Change the default `admin` / `admin123`
  password and don't share it with students.
- **Keep the computer awake & powered.** Set power settings so the host doesn't
  sleep. For a tunnel (Option A), the machine must stay on and online.
- **School network may block unknown domains.** If Option B's URL is blocked,
  try Option A (Cloudflare) or ask your school's IT to allow the domain.

---

## Quick reference

| Task | Command / Where |
|------|-----------------|
| Start locally | `node server.js` → `http://localhost:8080` |
| Pick a port | `PORT=9090 node server.js` |
| Easiest public HTTPS | Cloudflare Tunnel (Option A) |
| Own hostname + HTTPS | DuckDNS + Caddy (Option B) |
| Auto-start (Linux) | systemd unit (above) |
| Auto-start (Windows) | Startup folder `.bat` / NSSM |
| Admin login | `admin` / `admin123` |
| Student login | unique code (e.g. `READ-7X2K`) |

That's it — happy hosting!
