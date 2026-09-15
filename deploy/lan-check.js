#!/usr/bin/env node
/* ============================================================
 * lan-check.js — "why can't other devices reach my LAN IP?"
 * ------------------------------------------------------------
 * Dependency-free diagnostics for the LAN hosting setup in
 * HOSTING.md. Run it from the repo root:
 *
 *   node deploy/lan-check.js              # full check
 *   node deploy/lan-check.js --port=9090  # check a specific port
 *   node deploy/lan-check.js --serve-test # publish a test page on the port
 *   node deploy/lan-check.js --print-url  # just print the URL devices should use
 *
 * or:  npm run lan-check
 *
 * What it verifies, in order:
 *   1. which port/host the app would use (flags > env > saved setting > 8080)
 *   2. the LAN IPv4 addresses devices should use
 *   3. whether the port is actually listening
 *   4. whether the app answers on localhost AND on the LAN IP (the real test)
 *   5. firewall state, with the exact command to open the port
 *
 * Used by server.js too (banner + --lan-check), so the IP-detection helpers
 * live here and are exported at the bottom.
 * ============================================================ */
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const PLATFORM = os.platform();

/* ---------------------------- interface sniffing ---------------------------- */

/* Adapters that are never "the LAN" (loopback, container bridges, VPN tunnels
 * that devices can't reach, macOS internal interfaces). */
const SKIP_IFACE =
  /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|vboxif|tun|tap|utun|awdl|llw|anpi|bridge|gif|stf|isatap|zerotier|tailscale|wsl)/i;

function isPrivateIp(ip) {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("127.") ||
    ip.startsWith("169.254.")
  );
}

/* ---- which address does this machine actually use to talk to its network? ----
 * "First adapter we happen to enumerate" picks the wrong one all the time
 * (VirtualBox/WSL/Bluetooth adapters sort first). The OS routing table knows
 * which interface carries the default route, so we ask it. */
function routePrimary() {
  /* Manual override wins: BOOKRECS_LAN_IP=192.168.1.50 pins the advertised
   * address (multi-NIC machines, or a server behind a reverse proxy). */
  const pinned = String(process.env.BOOKRECS_LAN_IP || "").trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(pinned)) return { ip: pinned, via: "BOOKRECS_LAN_IP" };

  const probes =
    PLATFORM === "win32"
      ? [["route", ["print", "0.0.0.0"]]]
      : PLATFORM === "darwin"
      ? [["route", ["-n", "get", "default"]], ["ipconfig", ["getifaddr", "en0"]]]
      : [["ip", ["route", "get", "8.8.8.8"]], ["ip", "-4", "-o", "addr", "show", "scope", "global"].slice(0)];

  for (const probe of probes) {
    const out = shRun(probe[0], probe[1]).out;
    if (!out) continue;

    // Linux: "8.8.8.8 via 192.168.1.1 dev wlp3s0 src 192.168.1.50 uid 1000"
    const src = out.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
    if (src) return { ip: src[1], via: "default route" };

    // Linux fallback: "2: wlp3s0    inet 192.168.1.50/24 brd ... scope global wlp3s0"
    const addrLine = out
      .split(/\r?\n/)
      .map((l) => l.match(/inet (\d+\.\d+\.\d+\.\d+)\/\d+.*scope global (\S+)/))
      .filter(Boolean)[0];
    if (addrLine) return { ip: addrLine[1], iface: addrLine[2], via: "global scope address" };

    // macOS/BSD: "route: default via 192.168.1.1\n interface: en0"
    const iface = out.match(/interface:\s*(\S+)/);
    if (iface) return { iface: iface[1], via: "default route" };

    // Windows: "          0.0.0.0    0.0.0.0    192.168.1.1   192.168.1.50   291"
    let best = null;
    out.split(/\r?\n/).forEach((line) => {
      if (!/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s/.test(line)) return;
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || !/^\d+\.\d+\.\d+\.\d+$/.test(f[3])) return;
      const metric = Number(f[4]) || 0;
      if (!best || metric < best.metric) best = { ip: f[3], metric };
    });
    if (best) return { ip: best.ip, via: "default route" };
  }
  return {};
}

let _routeCache = { at: 0, val: {} };
function primaryRoute(force) {
  const now = Date.now();
  if (!force && now - _routeCache.at < 5000) return _routeCache.val;
  _routeCache = { at: now, val: routePrimary() };
  return _routeCache.val;
}

/** Clear the cache so a re-detect sees the current network state. */
function refreshNetwork() {
  return primaryRoute(true);
}

/** Classify an address so we never advertise something a device can't use. */
function classifyKind(ip) {
  if (ip.startsWith("169.254.")) return "apipa"; // no DHCP lease
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return "cgnat"; // CGNAT / Tailscale
  if (!isPrivateIp(ip)) return "public"; // not a LAN address at all
  return "usable";
}

/**
 * Every IPv4 address on this machine that a device could plausibly use, best
 * guess first. `primary` = the address the OS routing table says is the default
 * one. kind: "usable" | "apipa" | "cgnat" | "public".
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((a) => {
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (!isV4 || a.internal || SKIP_IFACE.test(name)) return;
      out.push({
        name,
        ip: a.address,
        netmask: a.netmask || "",
        cidr: a.cidr || "",
        kind: classifyKind(a.address),
        pinned: false,
      });
    });
  });

  const prim = primaryRoute();

  // A pinned address (BOOKRECS_LAN_IP) may be a NAT/proxy address that isn't on
  // any local adapter — still worth advertising, because the app answers on it.
  if (prim.ip && !out.some((a) => a.ip === prim.ip)) {
    out.push({
      name: prim.via === "BOOKRECS_LAN_IP" ? "pinned" : prim.iface || "default route",
      ip: prim.ip,
      netmask: "",
      cidr: "",
      kind: classifyKind(prim.ip),
      pinned: prim.via === "BOOKRECS_LAN_IP",
    });
  }

  out.forEach((a) => {
    a.primary = !!((prim.ip && prim.ip === a.ip) || (prim.iface && prim.iface === a.name));
  });

  const rank = (a) => {
    if (a.kind !== "usable") return 3;
    if (a.primary) return -1; // the adapter with the default route — what devices share
    if (/^192\.168\./.test(a.ip)) return 0;
    if (/^10\./.test(a.ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.ip)) return 1;
    return 2;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The URLs to type on a phone / another laptop. An address the user pinned with
 * BOOKRECS_LAN_IP is always honoured, even if it isn't on a local adapter (NAT,
 * reverse proxy, cloud public IP).
 */
function lanUrls(port) {
  return lanAddresses()
    .filter((a) => a.pinned || a.kind === "usable" || a.kind === "cgnat")
    .map((a) => `http://${a.ip}:${port}`);
}

/** The single best URL to hand out (auto-detected primary adapter wins). */
function bestUrl(port) {
  const urls = lanUrls(port);
  return urls.length ? urls[0] : "";
}

/**
 * Which address to hand out, and how it was chosen. `routed` false means the OS
 * gave us no default route (offline / container); `gatewayIsLinkLocal` means the
 * default route uses a link-local address — no DHCP lease, so no real LAN yet.
 */
function primaryInfo(port) {
  const prim = primaryRoute();
  const list = lanAddresses();
  const chosen =
    list.find((a) => a.pinned) ||
    list.find((a) => a.primary && (a.kind === "usable" || a.kind === "cgnat")) ||
    list.find((a) => a.kind === "usable");
  return {
    ip: chosen ? chosen.ip : "",
    iface: chosen ? chosen.name : "",
    url: chosen ? `http://${chosen.ip}:${port || 8080}` : "",
    via: prim.via || "",
    kind: chosen ? chosen.kind : "none",
    routed: !!(prim.ip || prim.iface),
    gatewayIsLinkLocal: /^169\.254\./.test(prim.ip || ""),
  };
}


/* --------------------------------- output ---------------------------------- */

const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);
const ok = (t) => console.log(`  ✓ ${t}`);
const bad = (t) => console.log(`  ✗ ${t}`);
const warn = (t) => console.log(`  ! ${t}`);
const info = (t) => console.log(`    ${t}`);
const cmd = (t) => console.log(`      $ ${t}`);

/* -------------------------------- helpers ---------------------------------- */

function readSavedPort() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "bookrecs-data.json"), "utf8"));
    return Number(data && data.settings && data.settings.port) || 0;
  } catch (e) {
    return 0;
  }
}

function shRun(cmdStr, args) {
  try {
    const res = spawnSync(cmdStr, args, { encoding: "utf8", timeout: 6000, windowsHide: true });
    if (res.error) return { err: res.error.message, out: String(res.error.message) };
    return { err: null, out: ((res.stdout || "") + (res.stderr || "")).trim() };
  } catch (e) {
    return { err: e.message, out: "" };
  }
}

/* Is something listening on this host:port? */
function probeListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const done = (result, detail) => {
      try { srv.close(); } catch (e) {}
      resolve({ listening: result, detail: detail || "" });
    };
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE") return done(true, "in use");
      if (err.code === "EACCES") return done(false, "permission denied");
      done(false, err.code || err.message);
    });
    srv.once("listening", () => done(false, "free"));
    srv.listen(port, host || "0.0.0.0");
  });
}

/* GET / and report the HTTP status (or the connection error). */
function probeHttp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: "/", timeout: timeoutMs || 3000, headers: { "User-Agent": "bookrecs-lan-check" } },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timed out"));
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
  });
}

/* -------------------------------- firewall --------------------------------- */

function firewallReport(port) {
  head("5) Firewall");
  if (PLATFORM === "win32") {
    const { out } = shRun("netsh", ["advfirewall", "show", "allprofiles", "state"]);
    const safeOut = out || "";
    const on = /State\s+ON/i.test(safeOut);
    const publicOn = /Public[\s\S]{0,80}?State\s+ON/i.test(safeOut);
    if (!safeOut.trim()) warn("Could not read the Windows Firewall state (not fatal).");
    else if (on) warn("Windows Firewall is ON" + (publicOn ? " and your network is set to PUBLIC." : "."));
    else ok("Windows Firewall is off — inbound is not the problem.");
    console.log("\n  Node has to be allowed to accept incoming connections. If you dismissed");
    console.log("  the pop-up (or you're on a Public network), run this in an");
    console.log("  elevated Command Prompt / PowerShell (right-click → Run as administrator):");
    cmd(`netsh advfirewall firewall add rule name="Classroom Book Recs ${port}" dir=in action=allow protocol=TCP localport=${port}`);
    console.log("  Then also make sure the adapter is Private (PowerShell, admin):");
    cmd("Get-NetConnectionProfile");
    cmd('Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private');
    return;
  }

  if (PLATFORM === "darwin") {
    const state = shRun("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]).out || "";
    const blockAll = shRun("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getblockall"]).out || "";
    // careful: the "disabled" reply contains "enabled"
    if (/firewall is enabled/i.test(state)) warn("macOS Application Firewall is ON." + (/all incoming/i.test(blockAll) ? " It is BLOCKING ALL incoming connections — nothing will reach the app." : ""));
    else ok("macOS firewall looks permissive enough for LAN access.");
    console.log("\n  If you do need to allow Node:");
    cmd(`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)`);
    cmd(`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)`);
    console.log("  And keep this Mac awake: System Settings → Displays → Prevent sleeping.");
    return;
  }

  // Linux & anything else
  const ufw = shRun("ufw", ["status"]);
  const fw = shRun("firewall-cmd", ["--state"]);
  if (/Status:\s*active/i.test(ufw.out || "")) {
    warn("ufw is active. Allow the port:");
    cmd(`sudo ufw allow ${port}/tcp comment 'Classroom Book Recs'`);
    cmd(`sudo ufw status numbered`);
  } else if (/running/i.test(fw.out || "")) {
    warn("firewalld is active. Allow the port:");
    cmd(`sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload`);
  } else if (ufw.err || !(ufw.out || "").trim()) {
    ok("No ufw/firewalld detected — firewall is probably not the blocker.");
    info("(if you run iptables/nftables by hand, check INPUT for a DROP rule)");
  } else {
    ok("Host firewall appears inactive.");
  }
}

/* --------------------------------- checks ---------------------------------- */

async function run(opts) {
  opts = opts || {};
  const port = opts.port || 8080;
  const host = opts.host || "0.0.0.0";
  const serveTest = !!opts.serveTest;

  const addrs = lanAddresses();
  const urls = lanUrls(port);
  const usable = addrs.filter((a) => a.kind === "usable");

  console.log(`\n  🔍  Classroom Book Recs — LAN reachability check`);
  console.log(`      ${PLATFORM} · node ${process.version} · ${os.hostname()}`);

  /* 1 — port / bind host */
  head("1) What the server would use");
  const envPort = parseInt(process.env.PORT || process.env.BOOKRECS_PORT || "", 10) || 0;
  const savedPort = readSavedPort();
  info(`effective port: ${port}  (--port flag > PORT env > bookrecs-data.json settings.port > 8080)`);
  if (envPort && envPort !== port) info(`note: PORT env says ${envPort}, a higher-precedence source wins`);
  if (savedPort && savedPort !== port)
    warn(`the saved admin setting "port" is ${savedPort}, but the server listens on ${port} — devices must use ${port}`);
  info(`bind host: ${host}` + (host === "127.0.0.1" ? "  ← localhost ONLY; other devices cannot connect" : "  ← every adapter (LAN reachable)"));

  /* 2 — addresses */
  head("2) LAN addresses devices should use");
  if (!addrs.length) {
    bad("No non-loopback IPv4 adapter found.");
    info("Inside Docker/WSL/VM? Publish the port (docker run -p 8080:8080) or run the");
    info("server on the host itself. A LAN IP only works for devices on the same network.");
  }
  const prim = primaryInfo(port);
  if (prim.ip)
    ok(`auto-detected for the banner + bookrecs-url.txt: ${prim.url}  (${prim.iface}${prim.via ? " · " + prim.via : ""})`);
  if (prim.gatewayIsLinkLocal)
    warn("The default route uses a link-local (169.254.x) address — no DHCP lease, so this machine isn't really on the LAN yet.");
  else if (!prim.routed)
    warn("No default route found — this machine has no working network (or it's a container without one).");
  addrs.forEach((a) => {
    if (a.kind === "usable") ok(`${a.ip}  (${a.name}${a.netmask ? " · mask " + a.netmask : ""}${a.primary ? " · default route" : ""})  → http://${a.ip}:${port}`);
    else if (a.kind === "apipa") warn(`${a.ip} (${a.name}) is an APIPA address — no DHCP lease, so the network is broken/unjoined. Reconnect Wi-Fi.`);
    else if (a.kind === "public") warn(`${a.ip} (${a.name}) is a PUBLIC address — it is not a LAN IP. Devices on your Wi-Fi need the 192.168/10.x address.`);
    else warn(`${a.ip} (${a.name}) is in 100.64.0.0/10 — CGNAT/Tailscale range; it works only for peers of that overlay, not for classroom Wi-Fi.`);
  });
  if (usable.length > 1)
    info("Multiple adapters: pick the one on the same network as the students (usually Wi-Fi).");
  if (usable.length === 1 && usable[0].netmask && usable[0].netmask !== "255.255.255.0")
    info(`Netmask ${usable[0].netmask} — confirm the client device is inside the same subnet.`);

  /* 3 — is the port listening, and on which address? */
  head("3) Is anything listening on that port?");
  const listen = await probeListen(port, "0.0.0.0");
  const onLan = usable.length ? await probeListen(port, usable[0].ip) : { listening: true };
  let boundLocalhostOnly = false;
  if (listen.listening && usable.length && !onLan.listening) {
    boundLocalhostOnly = true;
    bad(`Port ${port} is taken, but only on the loopback address — whatever is running`);
    info("is bound to 127.0.0.1, so no other device can reach it. Restart the app bound");
    info("to every adapter:");
    cmd(`node server.js --host=0.0.0.0`);
    info("(unset BOOKRECS_HOST / remove \"host\" restrictions from the service file)");
  } else if (listen.listening) ok(`Port ${port} is in use — a server is bound to 0.0.0.0:${port}.`);
  else {
    bad(`Port ${port} is FREE on 0.0.0.0 — nothing is serving it, so browsers will say`);
    info(`"This site can't be reached / connection refused". Start the app first:`);
    cmd(`node server.js`);
    info(`(or the systemd unit / start_bookrecs.bat from HOSTING.md)`);
  }
  if (listen.detail === "permission denied")
    warn(`Binding ${port} was permission-denied on this run — ports under 1024 need root. Use 8080 and put Caddy in front.`);

  /* 4 — the real test: localhost vs LAN IP */
  head("4) Does the app answer?  (localhost vs LAN IP)");
  const local = await probeHttp("127.0.0.1", port, 3000);
  const results = [];
  for (const a of usable.slice(0, 4)) results.push({ addr: a, res: await probeHttp(a.ip, port, 3500) });

  info(`http://127.0.0.1:${port}/  →  ${local.ok ? "HTTP " + local.status : local.error}`);
  results.forEach((r) =>
    info(`http://${r.addr.ip}:${port}/  →  ${r.res.ok ? "HTTP " + r.res.status : r.res.error}`)
  );

  let verdict = "";
  if (boundLocalhostOnly && local.ok && results.length && results.every((r) => !r.res.ok))
    verdict = "localhost-only";
  else if (!local.ok && local.error === "ECONNREFUSED")
    verdict = "not-running";
  else if (!local.ok && !listen.listening) verdict = "not-running";
  else if (local.ok && results.length && results.every((r) => !r.res.ok)) {
    const allTimeout = results.every((r) => /timed out|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(r.res.error || ""));
    verdict = allTimeout ? "blocked-on-lan" : "bad-bind";
  } else if (local.ok && results.some((r) => r.res.ok)) verdict = "reachable";
  else if (local.ok) verdict = "no-lan-iface";

  head("Verdict");
  if (verdict === "localhost-only") {
    bad("The server is answering on localhost only — that is why the LAN IP fails.");
    console.log("\n  It is bound to 127.0.0.1 instead of 0.0.0.0. Restart it pinned to all adapters:");
    cmd(`node server.js --host=0.0.0.0 --port=${port}`);
    info("then open http://<LAN IP above>:" + port + " from another device.");
  } else if (verdict === "reachable") {
    ok("The app answers on the LAN address — from this machine, that path works.");
    console.log("\n  If a phone/laptop on the same Wi-Fi STILL can't load it, the cause is one of:");
    info("a) That device is on a DIFFERENT network (guest Wi-Fi, cellular, another VLAN).");
    info("b) The router/AP has CLIENT ISOLATION on (common on school & guest Wi-Fi): devices");
    info("   can't see each other at all. Test with a phone hotspot — if it works there, your");
    info("   router needs isolation off, or you need the tunnel/DDNS route in HOSTING.md.");
    info("c) The firewall is allowing this machine to talk to itself but not inbound from the");
    info("   LAN — run the command in step 5.");
    info("d) A URL typo: use http:// not https://, the machine's IP (not 0.0.0.0/localhost),");
    info(`   and port ${port} (not 80/443 unless Caddy is in front).`);
  } else if (verdict === "blocked-on-lan") {
    bad("localhost answers, but the LAN address hangs/times out.");
    console.log("\n  That is the classic host-firewall signature (or client isolation):");
    info("1. Run the firewall command in step 5, then re-run this check.");
    info("2. Confirm the app really bound 0.0.0.0 — its startup line must say");
    info(`   "Listening on 0.0.0.0:${port}", not 127.0.0.1.`);
    info("3. Test from a device on the same Wi-Fi; if a hotspot test works but the school");
    info("   network doesn't, the school network blocks peer-to-peer traffic.");
  } else if (verdict === "bad-bind") {
    bad("localhost answers, the LAN address is refused, yet the port is bound on 0.0.0.0.");
    info("Something other than this app may hold the LAN address, or a proxy is in front of it.");
    info("Re-run with the port the app printed, e.g.:");
    cmd(`node deploy/lan-check.js --port=${port}`);
  } else if (verdict === "not-running") {
    bad(`Nothing is serving ${port}. The server isn't running (or it listens on another port).`);
    console.log("\n  Start it and read the URLs it prints:");
    cmd(`node server.js`);
    if (savedPort && savedPort !== port) {
      info(`Note: bookrecs-data.json has settings.port = ${savedPort}; restart pinned to one port with:`);
      cmd(`node server.js --port=${port}`);
    }
  } else if (verdict === "no-lan-iface") {
    warn("The app answers on localhost, but no usable LAN adapter was found to test.");
    info("Run this on the machine that actually hosts, and give devices that machine's IP.");
  } else {
    warn("Inconclusive — see the details above.");
  }

  /* 5 — firewall */
  firewallReport(port);

  /* 6 — extra context */
  head("6) Other things that break LAN access");
  info("· Reachability across networks: a LAN IP is only reachable on that local network.");
  info("  Students at school cannot use your home 192.168.x.x address — they need the");
  info("  Cloudflare Tunnel / DuckDNS URL from HOSTING.md.");
  info("· DHCP: the IP changes when the lease renews. Reserve it in your router, or re-run");
  info("  this check to get today's address.");
  info("· Sleep: if the host sleeps, the LAN IP stops answering. Disable sleep on the host.");
  info("· IPv6-only network: this app serves IPv4; make sure the client has IPv4 (most do).");
  info("· Stale PWA cache: if pages look outdated, hard-reload (Ctrl/Cmd+Shift+R) once.");
  info("· Port 80/443 in use by IIS/Apache? Keep the app on 8080 and proxy with Caddy.");

  if (serveTest) {
    head("Test page");
    const listen2 = await probeListen(port, "0.0.0.0");
    if (listen2.listening) {
      warn(`Port ${port} is busy, so the test page was not started. Try --serve-test with a free port:`);
      cmd(`node deploy/lan-check.js --serve-test --port=8090`);
    } else {
      const srv = net.createServer((sock) => {
        const remote = `${sock.remoteAddress}`;
        sock.end(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n" +
            `LAN OK — reached by ${remote}\nIf you can read this on that device, the network + firewall are fine.\n`
        );
        console.log(`  ✓ test page request from ${remote}`);
      });
      srv.listen(port, "0.0.0.0", () => {
        console.log(`  Listening… open these on other devices (Ctrl+C to stop):`);
        urls.concat([`http://localhost:${port}`]).forEach((u) => console.log(`    ${u}`));
        console.log(`\n  Works here but not on another device ⇒ firewall / different network / client isolation.\n`);
      });
      srv.on("error", (e) => bad(`Test page failed: ${e.code} ${e.message}`));
    }
  } else {
    head("Want a clean network-only test?");
    info("This check proves the machine side. To prove the network side, publish a plain");
    info("test page on the same port (stop the app first, or use a spare port):");
    cmd(`node deploy/lan-check.js --serve-test --port=8090`);
    info("…then open that URL from a phone on the same Wi-Fi.");
    console.log("");
  }
}

/* ------------------------------- CLI entry ------------------------------- */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const portFlag = argv.map((a) => a.match(/^--port=(\d+)$/)).find(Boolean);
  const hostFlag = argv.map((a) => a.match(/^--host=(.+)$/)).find(Boolean);
  const envPort = parseInt(process.env.PORT || process.env.BOOKRECS_PORT || "", 10) || 0;
  const port = (portFlag && Number(portFlag[1])) || envPort || readSavedPort() || 8080;

  // Just the URL — for a desktop shortcut, an email to the class, a shell script.
  if (argv.includes("--print-url") || argv.includes("--url")) {
    const url = bestUrl(port);
    console.log(url || `http://localhost:${port}`);
    process.exit(url ? 0 : 1);
  }

  run({ port, host: (hostFlag && hostFlag[1]) || "0.0.0.0", serveTest: argv.includes("--serve-test") });
}

module.exports = {
  run,
  lanAddresses,
  lanUrls,
  bestUrl,
  primaryInfo,
  primaryRoute,
  refreshNetwork,
  probeHttp,
  probeListen,
  isPrivateIp,
};
