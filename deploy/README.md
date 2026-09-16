# Deploy files — DuckDNS + Caddy (free HTTPS)

Everything in this folder is optional and only for the **host it at home**
(DuckDNS + Caddy) setup described in the repo's [HOSTING.md](../HOSTING.md).
You do not need any of it to run the site locally.

## What's here

| File | What it does | Platform |
|------|--------------|----------|
| `duckdns-update.sh` | Keeps your DuckDNS hostname pointed at your home IP (run every 5 min via cron). | Linux / Raspberry Pi |
| `duckdns.conf.example` | Your DuckDNS domain + token, read by the update script. Rename to `duckdns.conf`. | Linux / Raspberry Pi |
| `duckdns-update.bat` | Same auto-update, as a Windows scheduled task. Edit the domain/token inside. | Windows |
| `book-recs.service` | Runs `node server.js` automatically and restarts it on crash/reboot. | Linux (systemd) |
| `start_bookrecs.bat` | Starts the server on Windows. Put a shortcut in the Startup folder. | Windows |
| `lan-check.js` | Auto-detects the LAN address your class should use (via the OS default route) and diagnoses "other devices can't open the LAN IP": listening port, bind address, real LAN IPs, app answers on the LAN IP or only localhost, firewall state, plus the exact command to open the port. `--print-url` outputs just the URL; `--serve-test` publishes a test page. No dependencies. | All |
| `lan-check.bat` / `lan-check.sh` | Thin wrappers so you can double-click / `./` the check. | Windows / macOS-Linux |
| `../Caddyfile.example` | The only config Caddy needs — free HTTPS, routes to the app on port 8080. | All |

## The 30-second mental model

```
Students at school
        |
        |  https://mybookrecs.duckdns.org   (HTTPS, free cert)
        v
     Caddy (port 443)   <-- router forwards external 443 here
        |
        |  reverse_proxy localhost:8080
        v
   node server.js  (0.0.0.0:8080, shared data + sessions)
```

## Quick start — Linux / Windows

1. **DuckDNS hostname** — create one at https://www.duckdns.org, note the token.
2. **DuckDNS auto-update** — Linux: `cp duckdns.conf.example duckdns.conf`, fill
   it in, `./duckdns-update.sh`, add the cron line. Windows: edit + run the `.bat`,
   then create the scheduled task (instructions inside each file).
3. **Router** — reserve a static LAN IP for the hosting computer, then forward
   **external 443 → that computer → 443** (or → 8443 if you use the alternative
   Caddy block — see `../Caddyfile.example`).
4. **Caddy** — rename `../Caddyfile.example` to `Caddyfile`, put your real
   hostname in it, install Caddy, run `caddy run`.
5. **App** — start the server (`node server.js`, or the systemd/service files
   above). Confirm it prints `Listening on 0.0.0.0:8080`.
6. **Test** — on your phone's mobile data (not home Wi-Fi) open
   `https://mybookrecs.duckdns.org`.

## LAN-only hosting (no tunnel, no DDNS)

If the class is on the same network as the hosting computer you don't need any of
the files above: start `node server.js`, read the `Other devices: http://<ip>:8080`
line from its banner, open port `8080` in that machine's firewall, and verify with
`node deploy/lan-check.js`. The server auto-detects the address itself (printed at
startup, kept in `bookrecs-url.txt`, re-checked every 20 s, pinnable with
`BOOKRECS_LAN_IP`). Full walkthrough (including the troubleshooting table)
is in [../HOSTING.md](../HOSTING.md#option-c--lan-only-same-network-no-internet-needed).

## Backups

Your books, students, and questionnaires live in `bookrecs-data.json` on the
hosting computer. Copy it (plus `bookrecs-secret.key`) somewhere safe
regularly — a USB drive, network share, or cloud folder.

## Security (enforced server-side)

- **Students can't change the catalog or accounts.** Non-admin saves are
  restricted — students can only submit questionnaire responses.
- **Admin-only reset.** `POST /api/reset` is admin-only (403 otherwise).
- **Protect the admin account.** Share only the student codes.
  The `admin` account can manage everything, so change the password and don't
  share it.
