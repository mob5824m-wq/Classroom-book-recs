# Hosting your Classroom Book Recs at home (usable at school)

This guide shows you how to serve the Classroom Book Recs from a computer in your
home — either **on the local network only** (Option C, nothing to configure, no
internet needed) or **reached from school through a dynamic DNS / tunnel address**
(Options A and B).

> **Which one do you need?**
> - Devices on the **same Wi-Fi / LAN** as the computer running the app → Option C.
> - Anyone on a **different network** (school, home, a hotel) → Option A or B. A LAN
>   address such as `192.168.1.50` is only reachable inside its own network, so it can
>   never work from another site — that is expected, not a setting you can change.

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
Confirm it prints `Listening on 0.0.0.0:8080` and shows an
`Other devices: http://<ip>:8080` line (that LAN URL is what Option C uses).

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
   `Listening on 0.0.0.0:8080`. To keep it running automatically, use
   `deploy/book-recs.service` (Linux/systemd) or
   `deploy/start_bookrecs.bat` (Windows) — see below.

7. **Test from outside your home** — on a phone's data (not your Wi-Fi), open
   `https://mybookrecs.duckdns.org`. If it loads, you're live.

### Port model (the app listens on 0.0.0.0:8080 by default)

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

## Option C — LAN only (same network, no internet needed)

Everything else in this file is about reaching the app from *outside* your home.
If the class is on the same Wi-Fi / network as the computer running the app, you
need nothing but the five steps below — and the class keeps working even when
the internet is down.

### 1. Start the server and read the printed URL

```bash
node server.js
```

The startup banner prints the exact address every other device should use:

```
  Listening on 0.0.0.0:8080

  This computer:   http://localhost:8080
  Other devices:   http://192.168.1.50:8080   ← use THIS on phones/laptops
```

Two things trip people up here:

- **`0.0.0.0` is a bind address, not a URL.** It means "listen on every network
  adapter". Nobody types it into a browser.
- **`localhost` means "this device".** A student's tablet asking `localhost:8080`
  is asking its own tablet, not your computer. Only the LAN IP works for them.

If the banner says `no usable LAN address` / `no LAN IPv4 adapter`, the machine
isn't on a network yet (or it's in a container/VM — publish or forward the port).

### 2. Let the firewall through — the #1 reason LAN access "doesn't work"

| Host | Allow incoming TCP 8080 |
|------|-------------------------|
| **Windows** | In an *elevated* PowerShell/CMD: `netsh advfirewall firewall add rule name="Classroom Book Recs 8080" dir=in action=allow protocol=TCP localport=8080` |
| **Windows (GUI)** | Security → Firewall → "Allow an app through firewall" → tick **Node.js JavaScript Runtime** for Private **and** Public |
| **macOS** | System Settings → Network → Firewall → Options → allow incoming for `node` (or switch the firewall off on a trusted home network) |
| **Linux (ufw)** | `sudo ufw allow 8080/tcp` |
| **Linux (firewalld)** | `sudo firewall-cmd --permanent --add-port=8080/tcp && sudo firewall-cmd --reload` |

On Windows also: answer **Allow access** if the "Windows Firewall has blocked some
features of Node.js JavaScript Runtime" pop-up appears, and make sure the network is
set to **Private** — Public networks block inbound connections hard:

```powershell
Get-NetConnectionProfile
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

### 3. Give the host a stable IP

Reserve the host's LAN IP in your router (DHCP reservation by MAC address, e.g.
`192.168.1.50`). Otherwise the URL you handed out stops working when the lease
renews — and "it worked yesterday" is really "the IP changed".

### 4. Verify, don't guess

```bash
node deploy/lan-check.js                        # full report + the fix for whatever is wrong
node deploy/lan-check.js --port=9090             # check a non-default port
node deploy/lan-check.js --serve-test --port=8090  # plain test page, to prove the network path
```

`lan-check` confirms the port is actually listening on `0.0.0.0`, answers on the
**LAN IP** (not just localhost), shows the machine's real addresses, and prints the
firewall command your OS needs. `--serve-test` publishes a one-line test page so you
can tell "the network/firewall is fine, the app is the problem" from "the app is
fine, the network is the problem" — if your phone can load the test page but not the
app, the app isn't listening on that port.

### 5. Keep the host awake

- **Windows**: Settings → System → Power → Screen and sleep → *never* (when plugged in).
- **macOS**: `caffeinate -is` in a terminal while it's serving, or System Settings →
  Displays → "Prevent automatic sleeping on power adapter".
- **Linux / Pi**: `systemd-inhibit` isn't needed if the unit runs, but disable sleep:
  `sudo systemctl mask sleep.target suspend.target hibernate.target`.

A sleeping host is the second-most-common cause of "the LAN IP stopped working".

### LAN troubleshooting cheat-sheet

| Symptom on the other device | Usual cause | Fix |
|------------------------------|-------------|-----|
| "This site can't be reached" / *connection refused* | Nothing is listening on that port — the server is stopped, or it listens on a different port | `node server.js`, then use the port in its banner. `netstat -ano \| findstr :8080` (Win) / `lsof -i :8080` (macOS/Linux) shows what holds it |
| Spins for ~30 s then times out | Host firewall blocking inbound, or client isolation on the access point | Step 2, then re-test from a phone hotspot |
| Works on the host, nothing else works at all | Server bound to `127.0.0.1` (e.g. `BOOKRECS_HOST=127.0.0.1`) | Start with `node server.js --host=0.0.0.0` |
| Loads on some devices, not others | Those devices are on guest Wi-Fi / another VLAN / cellular | Put them on the same network, or use Option A |
| `https://192.168.1.50` fails | You typed https; the app serves plain http | Use `http://` (or run Caddy in front — Option B) |
| Worked yesterday, dead today | Host IP changed, or the machine slept / rebooted without auto-start | Steps 3 and 5 |
| Page loads but login/save fails | The app is being served from a cached copy while the server is down, or you opened it through a stale PWA entry | Hard-reload (Ctrl/Cmd+Shift+R); confirm `http://<LAN-IP>:8080/api/state` returns JSON |
| Everything is fine at home, fails at school | By design: a home LAN IP is not routable from school | Option A (Cloudflare Tunnel) or Option B (DuckDNS + Caddy) |
| School Wi-Fi blocks even a tunnel domain | Content filter | Ask IT to allow the domain, or use a phone hotspot as the network for the host |

### Picking a port

Precedence is **`--port` flag → `PORT` / `BOOKRECS_PORT` env → saved admin
setting → `8080`**. The app keeps one port in `bookrecs-data.json` so the address
you hand out doesn't drift, and the banner tells you when a higher-precedence
source overrode it:

```bash
node server.js --port=9090      # or: PORT=9090 node server.js
```

Keep `8080` unless you have a reason; every URL you've already shared contains it.
To bind a different interface (e.g. `127.0.0.1` only, for a machine behind Caddy),
use `--host=` or `BOOKRECS_HOST=`.

---

## Running the server automatically (so it's always on)

Keep the server running so students can use it whenever they're at school.

### macOS (MacBook)
Create `~/Library/LaunchAgents/com.bookrecs.server.plist` (start at login, restart on
crash), then load it:

```bash
cat > ~/Library/LaunchAgents/com.bookrecs.server.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.bookrecs.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>   <!-- /opt/homebrew/bin/node on Apple Silicon -->
    <string>/Users/YOU/Classroom-book-recs/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/Classroom-book-recs</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/bookrecs.log</string>
  <key>StandardErrorPath</key><string>/tmp/bookrecs.err</string>
</dict></plist>
EOF
launchctl unload ~/Library/LaunchAgents/com.bookrecs.server.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.bookrecs.server.plist
```

Also stop the Mac sleeping while it serves: System Settings → Displays → *Prevent
automatic sleeping when on power adapter* (or run `caffeinate -is` in a terminal).

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
Full setup, firewall commands and a troubleshooting table: **Option C** above;
`node deploy/lan-check.js` tells you which of the pieces is missing.

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
- **LAN IPs are not routable.** `http://192.168.1.50:8080` is only reachable from
  the network it lives on, and many school Wi-Fi networks additionally block
  device-to-device traffic (client isolation). Hosting at home and using it at
  school needs Option A or B.
- **Open the port on the host's firewall.** Inbound TCP 8080 must be allowed on the
  computer running the app — this is the most common cause of "the LAN IP doesn't
  work". `node deploy/lan-check.js` prints the exact command for your OS.
- **LAN and public hosting run together.** The app listens on `0.0.0.0:8080`, so
  `http://192.168.1.50:8080` at home and your tunnel/Caddy URL at school serve the
  same data at the same time — if the internet drops, the LAN address keeps working.
- **`bookrecs-secret.key` is what makes student passwords readable.** Keep it out of
  a public repo (`.gitignore` now lists it; the copy already committed stays in git
  history, so if this repo was ever public, rotate the key and reset student
  passwords). Back it up next to `bookrecs-data.json`.

---

## Quick reference

| Task | Command / Where |
|------|-----------------|
| Start locally | `node server.js` → `http://localhost:8080` |
| Other devices on the LAN | the `http://<LAN-IP>:8080` URL printed at startup (Option C) |
| Why can't devices reach the LAN IP? | `node deploy/lan-check.js` (or `npm run lan-check`) |
| Prove the network path alone | `node deploy/lan-check.js --serve-test --port=8090` |
| Pick a port | `node server.js --port=9090` (or `PORT=9090 node server.js`) |
| Serve this computer only | `node server.js --host=127.0.0.1` |
| Easiest public HTTPS | Cloudflare Tunnel (Option A) |
| Own hostname + HTTPS | DuckDNS + Caddy (Option B) |
| Auto-start (Linux) | systemd unit (above) |
| Auto-start (Windows) | Startup folder `.bat` / NSSM |
| Admin login | `admin` / `admin123` |
| Student login | unique code (e.g. `READ-7X2K`) |

That's it — happy hosting!
