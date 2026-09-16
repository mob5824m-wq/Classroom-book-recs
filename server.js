#!/usr/bin/env node
/* ============================================================
 * server.js — Classroom Book Recommendations server
 * ------------------------------------------------------------
 * Same architecture as classroomlib: vanilla Node.js HTTP server,
 * JSON file persistence, httpOnly session cookies, hashed admin
 * passwords, encrypted student code/password pairs.
 *
 *   node server.js            # serve on 0.0.0.0:8080 (LAN + localhost)
 *   node server.js --port=9090        # different port (or PORT=9090)
 *   node server.js --host=127.0.0.1   # this computer only
 *   node server.js --lan-check        # why can't other devices reach the LAN IP?
 *
 *   Other devices must use http://<this-computer's-LAN-IP>:8080 — printed at
 *   startup. "localhost" only ever works on the machine running the server.
 *
 * API:
 *   GET  /api/state             -> shared state (sensitive fields redacted)
 *   POST /api/state             -> save state (requires auth)
 *   POST /api/login             -> {code/password or username/password} -> session
 *   POST /api/logout            -> clears session
 *   GET  /api/me                -> current user (or 401)
 *   POST /api/change-password   -> change current user's password
 *   POST /api/questionnaire     -> save student questionnaire answers
 *   GET  /api/recommendations   -> get personalized book recommendations
 *   GET  /api/network           -> LAN URLs + firewall hint (admin only)
 *   POST /api/reset             -> reset all data (admin only)
 * ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DEFAULT_PORT = 8080;

/* Which address to bind. 0.0.0.0 = every network adapter, so the app is
 * reachable from other devices on the LAN (and by Caddy / a tunnel).
 * Set BOOKRECS_HOST=127.0.0.1 to keep it on this computer only.       */
const HOST = process.env.BOOKRECS_HOST || "0.0.0.0";

/* ---- CLI flags: --port=NNNN, --host=0.0.0.0, --lan-check, --print-url ---- */
const FLAGS = parseFlags(process.argv.slice(2));
function parseFlags(argv) {
  const out = { port: 0, host: "", lanCheck: false, printUrl: false, open: false, help: false };
  argv.forEach((arg) => {
    const port = arg.match(/^--port=(\d+)$/);
    const host = arg.match(/^--host=(.+)$/);
    if (port) out.port = parseInt(port[1], 10);
    else if (host) out.host = host[1];
    else if (arg === "--lan-check" || arg === "--lan-info" || arg === "lan-check")
      out.lanCheck = true;
    else if (arg === "--print-url" || arg === "--url") out.printUrl = true;
    else if (arg === "--open" || arg === "-o") out.open = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  });
  return out;
}
if (FLAGS.host) process.env.BOOKRECS_HOST = FLAGS.host;
const BIND_HOST = FLAGS.host || HOST;

/* Effective listen port — precedence: --port > PORT/BOOKRECS_PORT env >
 * saved admin setting > 8080. (See HOSTING.md "Picking a port".)        */
function resolveListenPort() {
  const saved = Number(state && state.settings && state.settings.port) || 0;
  const env = parseInt(process.env.PORT || process.env.BOOKRECS_PORT || "", 10) || 0;
  return FLAGS.port || env || saved || DEFAULT_PORT;
}

const DATA_FILE = path.join(ROOT, "bookrecs-data.json");
const URL_FILE = path.join(ROOT, "bookrecs-url.txt");
const COOKIE = "bookrecs_session";
const SESSION_TTL = 1000 * 60 * 60 * 6;
const SESSION_ABS_MAX = 1000 * 60 * 60 * 24 * 7;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/* ----------------------------- persistence ----------------------------- */
let state = null;
let savePending = false;
const sessions = new Map();
const SESSIONS_FILE = path.join(ROOT, "bookrecs-sessions.json");
let sessionsSavePending = false;

/* Sessions are saved to disk so they survive a restart — otherwise every
 * restart would sign the whole class out, and a student who was working on the
 * questionnaire when the server was updated would be dropped to the login page.
 * Expired sessions are dropped on the way in so the file can't grow forever. */
function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    const obj = JSON.parse(raw);
    const now = Date.now();
    let dropped = 0;
    Object.keys(obj).forEach((token) => {
      const sess = obj[token];
      const expired = !sess ||
        now - sess.lastActive > SESSION_TTL ||
        now - sess.created > SESSION_ABS_MAX;
      if (expired) dropped++;
      else sessions.set(token, sess);
    });
    if (dropped) persistSessions();
    const kept = sessions.size;
    if (kept) console.log(`  Restored ${kept} signed-in session${kept === 1 ? "" : "s"}${dropped ? ` (dropped ${dropped} expired)` : ""}`);
  } catch (e) { /* no file yet, or unreadable */ }
}

function persistSessions() {
  if (sessionsSavePending) return;
  sessionsSavePending = true;
  setTimeout(() => {
    sessionsSavePending = false;
    const obj = {};
    sessions.forEach((v, k) => (obj[k] = v));
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj)); } catch (e) {}
  }, 300);
}

function defaultState() {
  return {
    version: 2,
    books: [],
    users: [],
    classes: [],
    questionnaireDefs: [],
    responses: [],       // student answers (renamed from "questionnaires")
    recommendations: [],
    settings: {
      appName: "Book Recs",
      schoolName: "",
      room: "",
      port: DEFAULT_PORT,
      // Recommendations are handed out as two separate lists: books on our
      // shelves, and books we don't own (to find at the public library).
      libraryRecsPerStudent: 5,
      generalRecsPerStudent: 5,
      // Where the "we don't have it" picks come from: "openlibrary" grabs them
      // live (needs internet), "pool" uses the built-in list. Either way the
      // built-in list is the fallback when Open Library can't be reached.
      generalSource: "openlibrary",
      maxRecsPerStudent: 10, // legacy total, kept so older data still loads
      defaultPassword: "read123",
    },
  };
}

function loadData() {
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    state = defaultState();
  }
  migrate();
}

function migrate() {
  let changed = false;
  const def = defaultState();
  // Ensure all v2 fields exist
  Object.keys(def).forEach((k) => {
    if (state[k] === undefined) { state[k] = def[k]; changed = true; }
  });
  Object.keys(def.settings).forEach((k) => {
    if (state.settings[k] === undefined) {
      state.settings[k] = def.settings[k];
      changed = true;
    }
  });
  // Migrate v1 "questionnaires" (which held answers) to "responses"
  if (state.version < 2) {
    if (Array.isArray(state.questionnaires) && state.questionnaires.length && state.questionnaires[0].userId) {
      state.responses = state.questionnaires;
      state.questionnaires = [];
      changed = true;
    }
    state.version = 2;
  }
  // Migrate passwords: admin gets scrypt hash, students get encrypted code/password
  (state.users || []).forEach((u) => {
    if (u.role === "admin" && u.password && !u.pw) {
      u.pw = hashPassword(u.password);
      delete u.password;
      changed = true;
    }
    if (u.role === "student" && u.password && typeof u.password === "string") {
      u.password = encryptPassword(u.password);
      changed = true;
    }
  });
  if (changed) persist();
}

function persist() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("write failed:", e.message);
    }
  }, 200);
}

/* ------------------------------ passwords ------------------------------ */
const SECRET_FILE = path.join(ROOT, "bookrecs-secret.key");
let SECRET = "";
function loadSecret() {
  try { SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch (e) {}
  if (SECRET.length < 16) {
    SECRET = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); } catch (e) {}
  }
}
loadSecret();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}

function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(SECRET, "hex").slice(0, 32),
    iv
  );
  const enc = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

function decryptPassword(enc) {
  try {
    const iv = Buffer.from(enc.iv, "base64");
    const tag = Buffer.from(enc.tag, "base64");
    const data = Buffer.from(enc.data, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(SECRET, "hex").slice(0, 32),
      iv
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8"
    );
  } catch (e) {
    return "";
  }
}

function verifyPassword(pw, user) {
  if (!user) return false;
  // Students: decrypt stored password and compare
  if (user.role === "student" && user.password) {
    return decryptPassword(user.password) === String(pw);
  }
  // Admin: scrypt hash comparison
  if (user.pw) {
    const { salt, hash } = user.pw;
    try {
      const test = crypto
        .scryptSync(String(pw), salt, 64)
        .toString("hex");
      const a = Buffer.from(hash, "hex"),
        b = Buffer.from(test, "hex");
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) {
      return false;
    }
  }
  return false;
}

/* ----------------------------- sessions -------------------------------- */
function makeSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const sess = { userId, created: Date.now(), lastActive: Date.now() };
  sessions.set(token, sess);
  persistSessions();
  return token;
}

/* Session cookies: an HttpOnly one (normal) plus a readable one (proxy
 * fallback — see the comment above getSession). */
function sessionCookieHeaders(token) {
  return [
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
    `${COOKIE}_token=${token}; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
  ];
}

/* Every token this request carries, in order of trust:
 * 1. HttpOnly cookie (primary)
 * 2. Regular readable cookie (proxy fallback)
 * 3. X-Session-Token header (JavaScript localStorage fallback)
 * All of them are collected: a dead token in one spot must not hide a live
 * token in another (proxies drop or rewrite cookies, and the page keeps its
 * own copy), which otherwise looks exactly like being signed out. */
function sessionTokens(req) {
  const cookies = req.headers.cookie || "";
  const fromCookie = (cookies.match(new RegExp(`${COOKIE}=([a-f0-9]+)`)) || [])[1];
  const fromReadable = (cookies.match(new RegExp(`${COOKIE}_token=([a-f0-9]+)`)) || [])[1];
  const fromHeader = String(req.headers["x-session-token"] || "").trim();
  const seen = new Set();
  return [
    { token: fromCookie, source: "cookie" },
    { token: fromReadable, source: "readable-cookie" },
    { token: fromHeader, source: "header" },
  ].filter((c) => {
    if (!c.token || !/^[a-f0-9]+$/.test(c.token) || seen.has(c.token)) return false;
    seen.add(c.token);
    return true;
  });
}

function getSession(req, res) {
  const candidates = sessionTokens(req);
  if (!candidates.length) return null;
  const now = Date.now();
  for (const cand of candidates) {
    const sess = sessions.get(cand.token);
    if (!sess) continue;
    if (now - sess.lastActive > SESSION_TTL || now - sess.created > SESSION_ABS_MAX) {
      sessions.delete(cand.token);
      persistSessions();
      continue;
    }
    sess.lastActive = now;
    persistSessions();
    // Session came from a fallback source, so the browser is still holding a
    // stale cookie. Re-issue both cookies with the token that actually works.
    if (res && cand.source !== "cookie" && !res.headersSent) {
      res.setHeader("Set-Cookie", sessionCookieHeaders(cand.token));
    }
    return { token: cand.token, ...sess };
  }
  return null;
}

function clearSession(req) {
  let cleared = false;
  sessionTokens(req).forEach((cand) => {
    if (sessions.delete(cand.token)) cleared = true;
  });
  if (cleared) persistSessions();
}

/* ----------------------------- helpers --------------------------------- */
function redact(u) {
  const out = Object.assign({}, u);
  delete out.pw;
  delete out.password;
  out.hasPassword = !!(u.pw || u.password);
  return out;
}

function bodyJSON(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sanitizeNonAdminSave(sess, incoming) {
  // Non-admins can only modify their own profile and add questionnaires/recs
  const user = state.users.find((u) => u.id === sess.userId);
  if (!user || user.role === "admin") return incoming;

  // Clone current state for the protected fields
  const safe = Object.assign({}, incoming);
  safe.books = state.books;
  safe.classes = state.classes;
  safe.questionnaireDefs = state.questionnaireDefs;
  safe.users = state.users.map((u) => {
    if (u.id === sess.userId && incoming.users) {
      const updated = incoming.users.find((iu) => iu.id === u.id);
      if (updated) {
        const clone = Object.assign({}, u);
        clone.displayName = updated.displayName || u.displayName;
        return clone;
      }
    }
    return u;
  });
  safe.settings = state.settings;
  return safe;
}

/* ----------------------------- questionnaires ------------------------- */
function getQuestionnaireForStudent(userId) {
  const student = state.users.find((u) => u.id === userId);
  if (!student) return DEFAULT_QUESTIONS;
  const cls = (state.classes || []).find((c) => c.id === student.classId);
  if (!cls || !cls.questionnaireId) return DEFAULT_QUESTIONS;
  const qDef = (state.questionnaireDefs || []).find((q) => q.id === cls.questionnaireId);
  return qDef && qDef.questions && qDef.questions.length ? qDef.questions : DEFAULT_QUESTIONS;
}

const DEFAULT_QUESTIONS = [
  { id: "genres", question: "What genres do you enjoy?", type: "multi",
    options: ["Fantasy","Sci-Fi","Mystery","Romance","Horror","Historical Fiction","Adventure","Realistic Fiction","Humor","Graphic Novels","Non-Fiction","Poetry"] },
  { id: "reading_level", question: "How would you describe your reading level?", type: "single",
    options: ["Easy reads","Just right","Challenging me"] },
  { id: "book_length", question: "What book length do you prefer?", type: "single",
    options: ["Short (under 150 pages)","Medium (150-300 pages)","Long (300+ pages)","No preference"] },
  { id: "mood", question: "What kind of mood are you looking for?", type: "single",
    options: ["Light and fun","Dark and intense","Thought-provoking","Emotional and heartfelt","Action-packed","No preference"] },
  { id: "themes", question: "What themes interest you?", type: "multi",
    options: ["Friendship","Family","Identity","Justice","Survival","Coming of age","Technology","Nature","War & Conflict","Magic & Supernatural","Social Issues","Science"] },
  { id: "reading_habits", question: "How much do you read?", type: "single",
    options: ["I read all the time","I read sometimes","I don't read much but want to","I mostly read for school"] },
  { id: "setting_pref", question: "What kind of setting do you enjoy in a story?", type: "multi",
    options: ["Modern day","Medieval / old times","Futuristic / space","Small town","Big city","Wilderness / nature","School","Another world / fantasy realm"] },
  { id: "character_pref", question: "What kind of main character do you like?", type: "single",
    options: ["Someone my age","An adult","An animal","A group of friends","A loner / outsider","Doesn't matter"] },
  { id: "pace_pref", question: "What pace do you prefer?", type: "single",
    options: ["Fast-paced and action-packed","Slow build with big payoff","Mix of both","No preference"] },
  { id: "series_pref", question: "Do you prefer standalone books or series?", type: "single",
    options: ["Standalone (one book)","Series (multiple books)","Either is fine"] },
  { id: "avoid_pref", question: "What do you NOT want to read about?", type: "multi",
    options: ["Too much romance","Too scary / gory","Too sad","Too complicated","Boring topics","Nothing — I'm open to anything"] },
  { id: "fav_book", question: "What's a book you've loved? (optional)", type: "text" },
  { id: "fav_movie", question: "What's a movie or show you've enjoyed? (optional)", type: "text" },
  { id: "anything_else", question: "Anything else you want your teacher to know about what you like to read?", type: "text" },
];

/* Books we don't own, used to fill the "find it elsewhere" half of a student's
 * recommendations. They never appear in the catalog, only as suggestions, so a
 * classroom always has something to offer when the shelves are thin (or when
 * the machine has no internet).
 *
 * This list is now the FALLBACK: by default the suggestions are grabbed live
 * from Open Library, matched to the student's questionnaire answers (see the
 * Open Library section below). Teacher-added books marked "we don't have this"
 * still come first — see computeRecommendations(). */
const GENERAL_BOOK_POOL = [
  { title: "Harry Potter and the Sorcerer's Stone", author: "J.K. Rowling", isbn: "9780590353427", genres: ["Fantasy", "Adventure"], themes: ["Magic & Supernatural", "Friendship", "Coming of age"], mood: "Action-packed", setting: "Another world / fantasy realm", pace: "mixed", pages: 309, difficulty: "medium" },
  { title: "The Hunger Games", author: "Suzanne Collins", isbn: "9780439023481", genres: ["Sci-Fi", "Adventure"], themes: ["Survival", "Justice", "Coming of age"], mood: "Dark and intense", setting: "Futuristic / space", pace: "fast", pages: 374, difficulty: "medium" },
  { title: "The Wild Robot", author: "Peter Brown", isbn: "9780316381994", genres: ["Sci-Fi", "Adventure"], themes: ["Nature", "Survival", "Technology"], mood: "Emotional and heartfelt", setting: "Wilderness / nature", pace: "mixed", pages: 279, difficulty: "easy" },
  { title: "Amari and the Night Brothers", author: "B.B. Alston", isbn: "9780062975171", genres: ["Fantasy", "Mystery"], themes: ["Magic & Supernatural", "Identity", "Friendship"], mood: "Action-packed", setting: "Modern day", pace: "fast", pages: 416, difficulty: "medium" },
  { title: "Front Desk", author: "Kelly Yang", isbn: "9781338151794", genres: ["Realistic Fiction"], themes: ["Social Issues", "Family", "Justice"], mood: "Emotional and heartfelt", setting: "Modern day", pace: "mixed", pages: 286, difficulty: "easy" },
  { title: "New Kid", author: "Jerry Craft", isbn: "9780062691194", genres: ["Graphic Novels", "Realistic Fiction"], themes: ["Identity", "Friendship", "Social Issues"], mood: "Light and fun", setting: "School", pace: "mixed", pages: 256, difficulty: "easy" },
  { title: "Smile", author: "Raina Telgemeier", isbn: "9780545132060", genres: ["Graphic Novels", "Realistic Fiction"], themes: ["Coming of age", "Family", "Identity"], mood: "Emotional and heartfelt", setting: "School", pace: "mixed", pages: 224, difficulty: "easy" },
  { title: "Because of Winn-Dixie", author: "Kate DiCamillo", isbn: "9780763680862", genres: ["Realistic Fiction"], themes: ["Friendship", "Family"], mood: "Emotional and heartfelt", setting: "Small town", pace: "slow", pages: 182, difficulty: "easy" },
  { title: "Esperanza Rising", author: "Pam Muñoz Ryan", isbn: "9780439120425", genres: ["Historical Fiction", "Realistic Fiction"], themes: ["Family", "Justice", "Identity"], mood: "Emotional and heartfelt", setting: "Small town", pace: "mixed", pages: 262, difficulty: "medium" },
  { title: "Bridge to Terabithia", author: "Katherine Paterson", isbn: "9780064401845", genres: ["Realistic Fiction", "Fantasy"], themes: ["Friendship", "Coming of age"], mood: "Emotional and heartfelt", setting: "Small town", pace: "mixed", pages: 128, difficulty: "easy" },
  { title: "Charlotte's Web", author: "E.B. White", isbn: "9780064400558", genres: ["Fantasy", "Realistic Fiction"], themes: ["Friendship", "Nature", "Family"], mood: "Emotional and heartfelt", setting: "Small town", pace: "slow", pages: 192, difficulty: "easy" },
  { title: "The Lion, the Witch and the Wardrobe", author: "C.S. Lewis", isbn: "9780064404990", genres: ["Fantasy", "Adventure"], themes: ["Magic & Supernatural", "War & Conflict", "Family"], mood: "Action-packed", setting: "Another world / fantasy realm", pace: "fast", pages: 208, difficulty: "easy" },
  { title: "Matilda", author: "Roald Dahl", isbn: "9780142410370", genres: ["Humor", "Fantasy"], themes: ["Identity", "Justice", "Family"], mood: "Light and fun", setting: "School", pace: "fast", pages: 240, difficulty: "easy" },
  { title: "Hoot", author: "Carl Hiaasen", isbn: "9780440419396", genres: ["Mystery", "Realistic Fiction"], themes: ["Nature", "Justice", "Friendship"], mood: "Light and fun", setting: "School", pace: "mixed", pages: 292, difficulty: "medium" },
  { title: "The War That Saved My Life", author: "Kimberly Brubaker Bradley", isbn: "9780147510488", genres: ["Historical Fiction"], themes: ["War & Conflict", "Family", "Survival"], mood: "Emotional and heartfelt", setting: "Small town", pace: "mixed", pages: 316, difficulty: "medium" },
  { title: "Out of My Mind", author: "Sharon M. Draper", isbn: "9781416971719", genres: ["Realistic Fiction"], themes: ["Identity", "Friendship", "Social Issues"], mood: "Emotional and heartfelt", setting: "School", pace: "mixed", pages: 295, difficulty: "medium" },
  { title: "The One and Only Ivan", author: "Katherine Applegate", isbn: "9780061992278", genres: ["Realistic Fiction", "Fantasy"], themes: ["Friendship", "Nature", "Identity"], mood: "Emotional and heartfelt", setting: "Modern day", pace: "slow", pages: 300, difficulty: "easy" },
  { title: "Refugee", author: "Alan Gratz", isbn: "9780545880831", genres: ["Historical Fiction", "Adventure"], themes: ["Survival", "War & Conflict", "Family"], mood: "Dark and intense", setting: "Modern day", pace: "fast", pages: 338, difficulty: "medium" },
  { title: "Restart", author: "Gordon Korman", isbn: "9781338053777", genres: ["Realistic Fiction", "Mystery"], themes: ["Identity", "Friendship", "Coming of age"], mood: "Thought-provoking", setting: "School", pace: "fast", pages: 243, difficulty: "easy" },
  { title: "A Long Walk to Water", author: "Linda Sue Park", isbn: "9780547577319", genres: ["Historical Fiction", "Adventure"], themes: ["Survival", "War & Conflict", "Social Issues"], mood: "Thought-provoking", setting: "Wilderness / nature", pace: "fast", pages: 128, difficulty: "easy" },
  { title: "Long Way Down", author: "Jason Reynolds", isbn: "9781481438254", genres: ["Poetry", "Realistic Fiction"], themes: ["Justice", "Coming of age", "Social Issues"], mood: "Dark and intense", setting: "Big city", pace: "fast", pages: 306, difficulty: "medium" },
  { title: "Ghost", author: "Jason Reynolds", isbn: "9781481450157", genres: ["Realistic Fiction"], themes: ["Identity", "Family", "Coming of age"], mood: "Emotional and heartfelt", setting: "Modern day", pace: "fast", pages: 195, difficulty: "easy" },
  { title: "The Crossover", author: "Kwame Alexander", isbn: "9780544107717", genres: ["Poetry", "Realistic Fiction"], themes: ["Family", "Coming of age", "Identity"], mood: "Emotional and heartfelt", setting: "School", pace: "fast", pages: 237, difficulty: "easy" },
  { title: "Counting by 7s", author: "Holly Goldberg Sloan", isbn: "9780142422854", genres: ["Realistic Fiction"], themes: ["Identity", "Friendship", "Family"], mood: "Thought-provoking", setting: "School", pace: "slow", pages: 378, difficulty: "medium" },
  { title: "El Deafo", author: "Cece Bell", isbn: "9781419710209", genres: ["Graphic Novels", "Non-Fiction"], themes: ["Identity", "Friendship", "Social Issues"], mood: "Emotional and heartfelt", setting: "School", pace: "mixed", pages: 248, difficulty: "easy" },
  { title: "The Girl Who Drank the Moon", author: "Kelly Barnhill", isbn: "9781616205676", genres: ["Fantasy", "Adventure"], themes: ["Magic & Supernatural", "Family", "Coming of age"], mood: "Dark and intense", setting: "Another world / fantasy realm", pace: "slow", pages: 388, difficulty: "medium" },
  { title: "Wishtree", author: "Katherine Applegate", isbn: "9781250043221", genres: ["Fantasy", "Realistic Fiction"], themes: ["Nature", "Friendship", "Identity"], mood: "Thought-provoking", setting: "Small town", pace: "slow", pages: 224, difficulty: "easy" },
  { title: "Brown Girl Dreaming", author: "Jacqueline Woodson", isbn: "9780147515827", genres: ["Poetry", "Non-Fiction"], themes: ["Identity", "Family", "Social Issues"], mood: "Thought-provoking", setting: "Small town", pace: "slow", pages: 337, difficulty: "medium" },
  { title: "Inside Out and Back Again", author: "Thanhha Lai", isbn: "9780061962790", genres: ["Poetry", "Historical Fiction"], themes: ["Family", "Survival", "Identity"], mood: "Emotional and heartfelt", setting: "Modern day", pace: "slow", pages: 272, difficulty: "easy" },
  { title: "Bud, Not Buddy", author: "Christopher Paul Curtis", isbn: "9780440413288", genres: ["Historical Fiction", "Mystery"], themes: ["Family", "Identity", "Justice"], mood: "Light and fun", setting: "Small town", pace: "mixed", pages: 245, difficulty: "easy" },
  { title: "Walk Two Moons", author: "Sharon Creech", isbn: "9780064405171", genres: ["Realistic Fiction", "Mystery"], themes: ["Family", "Friendship", "Coming of age"], mood: "Emotional and heartfelt", setting: "Small town", pace: "slow", pages: 280, difficulty: "medium" },
  { title: "The Westing Game", author: "Ellen Raskin", isbn: "9780142401200", genres: ["Mystery"], themes: ["Justice", "Identity"], mood: "Thought-provoking", setting: "Big city", pace: "fast", pages: 216, difficulty: "medium" },
  { title: "Frindle", author: "Andrew Clements", isbn: "9780689818769", genres: ["Humor", "Realistic Fiction"], themes: ["Identity", "Friendship"], mood: "Light and fun", setting: "School", pace: "fast", pages: 105, difficulty: "easy" },
  { title: "The Phantom Tollbooth", author: "Norton Juster", isbn: "9780394820378", genres: ["Fantasy", "Adventure"], themes: ["Magic & Supernatural", "Coming of age"], mood: "Light and fun", setting: "Another world / fantasy realm", pace: "fast", pages: 256, difficulty: "medium" },
  { title: "Charlie and the Chocolate Factory", author: "Roald Dahl", isbn: "9780142410318", genres: ["Fantasy", "Humor"], themes: ["Family", "Identity"], mood: "Light and fun", setting: "Another world / fantasy realm", pace: "fast", pages: 192, difficulty: "easy" },
  { title: "Ella Enchanted", author: "Gail Carson Levine", isbn: "9780064407052", genres: ["Fantasy", "Romance"], themes: ["Magic & Supernatural", "Identity"], mood: "Light and fun", setting: "Medieval / old times", pace: "mixed", pages: 232, difficulty: "easy" },
  { title: "The Maze Runner", author: "James Dashner", isbn: "9780385737951", genres: ["Sci-Fi", "Adventure"], themes: ["Survival", "Technology", "Friendship"], mood: "Action-packed", setting: "Futuristic / space", pace: "fast", pages: 374, difficulty: "medium" },
  { title: "Shiloh", author: "Phyllis Reynolds Naylor", isbn: "9780689835827", genres: ["Realistic Fiction"], themes: ["Friendship", "Family", "Nature"], mood: "Emotional and heartfelt", setting: "Small town", pace: "slow", pages: 144, difficulty: "easy" },
  { title: "Al Capone Does My Shirts", author: "Gennifer Choldenko", isbn: "9780142404195", genres: ["Historical Fiction", "Realistic Fiction"], themes: ["Family", "Friendship", "Identity"], mood: "Light and fun", setting: "School", pace: "mixed", pages: 228, difficulty: "easy" },
  { title: "Becoming Naomi León", author: "Pam Muñoz Ryan", isbn: "9780439269971", genres: ["Realistic Fiction"], themes: ["Family", "Identity", "Coming of age"], mood: "Emotional and heartfelt", setting: "Small town", pace: "slow", pages: 246, difficulty: "easy" },
].map((b, i) => ({ id: "sugg-" + (i + 1), ...b, inLibrary: false, suggested: true, approved: true }));

/* ------------------- Open Library (live suggestions) -------------------
 * The "Books We Don't Have (Yet)" list is grabbed live from Open Library,
 * queried with the words from the student's questionnaire (genres + themes) and
 * then scored with the same scoreBook() used for our own shelves, so both lists
 * are ranked the same way.
 *
 * Everything here is best-effort: a slow or unreachable Open Library (no
 * internet in the classroom is normal) falls back to GENERAL_BOOK_POOL above,
 * and a teacher can switch it off entirely with Settings ▸ suggestion source.
 */
const OL_BASE = (process.env.BOOKRECS_OL_BASE || "https://openlibrary.org").replace(/\/+$/, "");
const OL_TIMEOUT_MS = parseInt(process.env.BOOKRECS_OL_TIMEOUT_MS, 10) || 5000;
const OL_UA = "ClassroomBookRecs/1.0 (classroom book recommendations; teacher-run)";
const OL_CACHE_TTL = 1000 * 60 * 60 * 6;   // reuse a query's results for 6 hours
const OL_CACHE_MAX = 200;                  // keep memory bounded
const OL_DOWN_COOLDOWN = 1000 * 60;        // after a failure, stop trying for a minute
const olCache = new Map();                 // query -> { at, docs }
const olInFlight = new Map();              // query -> in-flight promise (dedupe)
let olDownUntil = 0;                       // set when Open Library looks unreachable

/* Questionnaire genre -> Open Library subject. OL's subject strings are its
 * own vocabulary, so the words a student picks need translating. */
const OL_GENRE_SUBJECTS = {
  "fantasy": "fantasy fiction",
  "sci-fi": "science fiction",
  "mystery": "detective and mystery stories",
  "romance": "romance fiction",
  "horror": "horror tales",
  "historical fiction": "historical fiction",
  "adventure": "adventure stories",
  "realistic fiction": "children's fiction",
  "humor": "humorous stories",
  "graphic novels": "comic books, strips",
  "non-fiction": "juvenile nonfiction",
  "poetry": "children's poetry",
};
const OL_THEME_SUBJECTS = {
  "friendship": "friendship",
  "family": "families",
  "identity": "identity",
  "justice": "justice",
  "survival": "survival",
  "coming of age": "coming of age",
  "technology": "technology",
  "nature": "nature",
  "war & conflict": "war",
  "magic & supernatural": "magic",
  "social issues": "social issues",
  "science": "science",
};

/* Nothing adult should reach a middle-school student, and a 900-page epic is no
 * use to a Grade 7 class. Reject on subjects/title, and on length. */
const OL_BLOCKED_WORDS = [
  "erotica", "erotic", "pornograph", "bdsm", "sexual content", "adult fiction",
  "sexual behaviour", "sexual behavior", "sex instruction", "true crime",
  "serial murder", "murderers—", "drug abuse", "incest",
];
const OL_MIN_PAGES = 70;
const OL_MAX_PAGES = 700;

function olSearchUrl(params) {
  const u = new URL(`${OL_BASE}/search.json`);
  Object.keys(params).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
      u.searchParams.set(k, params[k]);
    }
  });
  return u.toString();
}

/* One Open Library search, with a hard timeout so nobody waits on it forever. */
async function openLibrarySearch(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OL_TIMEOUT_MS);
  try {
    const res = await fetch(olSearchUrl(params), {
      headers: { "User-Agent": OL_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.docs) ? data.docs : [];
  } finally {
    clearTimeout(timer);
  }
}

/* Turn the questionnaire answers into a plain-word search. Plain words (rather
 * than subject:... operators) keep this robust: Open Library matches title,
 * author and subject text, and scoreBook() does the fine ranking afterwards. */
function buildOpenLibraryQuery(prefs) {
  const words = [];
  const genres = (prefs.genres || []).slice(0, 3);
  const subjects = genres.map((g) => OL_GENRE_SUBJECTS[String(g).toLowerCase()]).filter(Boolean);
  // Primary genre drives the search; extra genres just widen it.
  if (subjects[0]) words.push(subjects[0]);
  const themes = (prefs.themes || []).slice(0, 3)
    .filter((t) => !/^nothing/i.test(String(t)))
    .map((t) => OL_THEME_SUBJECTS[String(t).toLowerCase()] || String(t).toLowerCase());
  words.push(...themes.slice(0, 2));
  if (subjects.length > 1 && words.length < 4) words.push(subjects[1]);

  // Nothing usable in the answers (e.g. only free-text replies): a broad
  // middle-grade query still gives the student something to read.
  if (!words.length) words.push("juvenile fiction", "adventure", "friendship");

  return words.join(" ");
}

function olIsAllowed(doc) {
  const haystack = [
    doc.title,
    ...(doc.subject || []).slice(0, 30),
  ].join(" ").toLowerCase();
  if (OL_BLOCKED_WORDS.some((w) => haystack.includes(w))) return false;
  // English only — the query already asks for it, this catches stragglers.
  if (Array.isArray(doc.language) && doc.language.length && !doc.language.includes("eng")) return false;
  const pages = Number(doc.number_of_pages_median) || 0;
  if (pages && (pages < OL_MIN_PAGES || pages > OL_MAX_PAGES)) return false;
  return true;
}

/* Reverse of the maps above: Open Library subjects -> the genre/theme tags this
 * app uses, so the cards look the same as books from our own shelves and
 * scoreBook() can match them against what the student asked for. */
function olTaxonomy(doc) {
  const subjects = (doc.subject || []).map((s) => s.toLowerCase());
  const has = (...needles) => subjects.some((s) => needles.some((n) => s.includes(n)));

  const genres = [];
  if (has("fantasy")) genres.push("Fantasy");
  if (has("science fiction", "sci-fi")) genres.push("Sci-Fi");
  if (has("detective and mystery", "mystery", "detective")) genres.push("Mystery");
  if (has("romance", "love stories")) genres.push("Romance");
  if (has("horror", "ghost stories")) genres.push("Horror");
  if (has("historical fiction", "history")) genres.push("Historical Fiction");
  if (has("adventure")) genres.push("Adventure");
  if (has("humorous", "humour", "humor", "comic")) genres.push("Humor");
  if (has("comic books", "graphic novel", "strip")) genres.push("Graphic Novels");
  if (has("poetry", "poems")) genres.push("Poetry");
  if (has("juvenile nonfiction", "nonfiction", "non-fiction")) genres.push("Non-Fiction");
  if (!genres.length && has("juvenile fiction", "children's fiction", "fiction")) genres.push("Realistic Fiction");

  const themes = [];
  if (has("friendship", "friends")) themes.push("Friendship");
  if (has("families", "family")) themes.push("Family");
  if (has("identity")) themes.push("Identity");
  if (has("justice")) themes.push("Justice");
  if (has("survival")) themes.push("Survival");
  if (has("coming of age")) themes.push("Coming of age");
  if (has("technology")) themes.push("Technology");
  if (has("nature")) themes.push("Nature");
  if (has("war")) themes.push("War & Conflict");
  if (has("magic", "supernatural")) themes.push("Magic & Supernatural");
  if (has("social issues")) themes.push("Social Issues");
  if (has("science")) themes.push("Science");

  return { genres: genres.slice(0, 3), themes: themes.slice(0, 4) };
}

function olAvailability(doc) {
  const access = String(doc.ebook_access || "");
  if (access === "public") return { kind: "public", label: "Read it free on Open Library" };
  if (access === "borrowable") return { kind: "borrow", label: "Borrow it free on Open Library" };
  return { kind: "print", label: "Look for it at your public library" };
}

function olDocToBook(doc) {
  const tax = olTaxonomy(doc);
  const key = doc.key || "";
  const availability = olAvailability(doc);
  return {
    id: "ol-" + (key.replace(/[^a-zA-Z0-9]/g, "") || crypto.randomBytes(4).toString("hex")),
    title: doc.title || "",
    author: (doc.author_name || []).slice(0, 2).join(", "),
    genres: tax.genres,
    themes: tax.themes,
    pages: Number(doc.number_of_pages_median) || null,
    firstPublished: doc.first_publish_year || null,
    isbn: (doc.isbn || [])[0] || "",
    // Kept so an owned copy is recognised even when Open Library lists a
    // different printing first.
    isbns: (doc.isbn || []).slice(0, 20),
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : "",
    openLibraryKey: key,
    openLibraryUrl: key ? `https://openlibrary.org${key}` : "",
    availability: availability.kind,
    availabilityLabel: availability.label,
    inLibrary: false,
    source: "openlibrary",
    approved: true,
  };
}

/* Search Open Library for this student, newest results each time "refresh" is
 * set regardless of the cache. Returns [] if Open Library can't be reached. */
async function fetchOpenLibraryBooks(prefs, opts = {}) {
  // No internet (or a firewall silently dropping packets): don't make every
  // student in the class wait for the timeout — fall straight to the saved list
  // until the cooldown expires.
  if (Date.now() < olDownUntil) return null;

  const q = buildOpenLibraryQuery(prefs);
  // Rotate through a few pages of results so a refresh shows new books, and
  // never hammer one page of results for every student in the class.
  const offset = opts.refresh ? [0, 40, 80, 120][Math.floor(Math.random() * 4)] : 0;
  const cacheKey = `${q}|${offset}`;

  const cached = olCache.get(cacheKey);
  if (!opts.refresh && cached && Date.now() - cached.at < OL_CACHE_TTL) return cached.docs;
  if (olInFlight.has(cacheKey)) return olInFlight.get(cacheKey);

  const pending = openLibrarySearch({
    q,
    fields: "key,title,author_name,first_publish_year,isbn,number_of_pages_median,subject,cover_i,ebook_access,language",
    limit: 60,
    offset,
    language: "eng",
  })
    .then((docs) => {
      if (olCache.size >= OL_CACHE_MAX) olCache.delete(olCache.keys().next().value);
      olCache.set(cacheKey, { at: Date.now(), docs });
      olDownUntil = 0;
      console.log(`[openlibrary] "${q}" -> ${docs.length} result(s)`);
      return docs;
    })
    .catch((e) => {
      olDownUntil = Date.now() + OL_DOWN_COOLDOWN;
      console.log(`[openlibrary] unavailable (${e.message}) — using the built-in suggestion list for the next ${Math.round(OL_DOWN_COOLDOWN / 1000)}s`);
      return null; // null = "couldn't reach it", [] would mean "no matches"
    })
    .finally(() => olInFlight.delete(cacheKey));

  olInFlight.set(cacheKey, pending);
  return pending;
}


/* How much a book suits a student's questionnaire answers. Used for both the
 * class-library list and the "we don't have it" list so the two are ranked the
 * same way. */
function scoreBook(book, prefs) {
  const likedGenres = prefs.genres || [];
  const themes = prefs.themes || [];
  const mood = prefs.mood || "";
  const bookLength = prefs.book_length || "";
  const readingLevel = prefs.reading_level || "";
  const settingPref = prefs.setting_pref || [];
  const pacePref = prefs.pace_pref || "";
  const avoidPref = prefs.avoid_pref || [];

  let score = 0;
  const bookGenres = (book.genres || []).map((g) => g.toLowerCase());
  const bookThemes = (book.themes || []).map((t) => t.toLowerCase());
  const bookSetting = (book.setting || "").toLowerCase();

  // Genre match (highest weight)
  likedGenres.forEach((g) => {
    if (bookGenres.includes(g.toLowerCase())) score += 10;
  });

  // Theme match
  themes.forEach((t) => {
    if (bookThemes.includes(t.toLowerCase())) score += 5;
  });

  // Mood match
  if (mood && book.mood && mood !== "No preference") {
    if (book.mood.toLowerCase() === mood.toLowerCase()) score += 4;
  }

  // Book length preference
  if (bookLength && bookLength !== "No preference" && book.pages) {
    if (bookLength.includes("Short") && book.pages < 150) score += 3;
    else if (bookLength.includes("Medium") && book.pages >= 150 && book.pages <= 300) score += 3;
    else if (bookLength.includes("Long") && book.pages > 300) score += 3;
  }

  // Reading level match
  if (readingLevel && book.difficulty) {
    if (readingLevel === "Easy reads" && book.difficulty === "easy") score += 3;
    if (readingLevel === "Just right" && book.difficulty === "medium") score += 3;
    if (readingLevel === "Challenging me" && book.difficulty === "hard") score += 3;
  }

  // Setting preference match
  if (settingPref.length && bookSetting) {
    settingPref.forEach((s) => {
      if (bookSetting.includes(s.toLowerCase())) score += 3;
    });
  }

  // Pace preference
  if (pacePref && pacePref !== "No preference" && book.pace) {
    if (pacePref.includes("Fast") && book.pace === "fast") score += 3;
    if (pacePref.includes("Slow") && book.pace === "slow") score += 3;
    if (pacePref.includes("Mix") && book.pace === "mixed") score += 3;
  }

  // Avoid penalty (reduce score if book matches something student wants to avoid)
  if (avoidPref.length && !avoidPref.includes("Nothing — I'm open to anything")) {
    avoidPref.forEach((a) => {
      if (a.includes("romance") && bookThemes.includes("romance")) score -= 8;
      if (a.includes("scary") && bookGenres.includes("horror")) score -= 8;
      if (a.includes("sad") && book.mood && book.mood.toLowerCase().includes("emotional")) score -= 5;
      if (a.includes("complicated") && book.difficulty === "hard") score -= 4;
    });
  }

  // Teacher-picked bonus
  if (book.teacherPick) score += 2;

  return score;
}

/* Best matches first; books nothing in the answers points at are dropped. */
function rankBooks(books, prefs) {
  return books
    .map((book) => ({ ...book, score: scoreBook(book, prefs) }))
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score);
}

/* The highest score a book could reach given this student's answers, so a
 * match percentage means something (the old fixed "score / 30" pinned nearly
 * everything at 100%). Mirrors the weights in scoreBook(). */
function maxPossibleScore(prefs) {
  let max = 0;
  max += (prefs.genres || []).length * 10;
  max += (prefs.themes || []).length * 5;
  if (prefs.mood && prefs.mood !== "No preference") max += 4;
  if (prefs.book_length && prefs.book_length !== "No preference") max += 3;
  if (prefs.reading_level) max += 3;
  max += (prefs.setting_pref || []).length * 3;
  if (prefs.pace_pref && prefs.pace_pref !== "No preference") max += 3;
  max += 2; // teacher pick
  return max;
}

/* "The Hobbit" and "hobbit, the" are the same book. Used to keep the
 * "we don't have it" list from suggesting something that is on the shelf. */
function titleKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function isbnKey(s) {
  return String(s || "").replace(/\D/g, "");
}

/* Words that say nothing about WHICH book it is: "Holes: A Novel" is Holes. */
const TITLE_NOISE = /^(a|an|the)?\s*(novel|novels|book|books|memoir|graphic novel|series|edition|unabridged|volume|vol)\b/;

/* The parts of a title that name the book: the whole thing, plus each side of a
 * colon, minus series tags in brackets and non-titles like "A Novel".
 *   "Percy Jackson: The Lightning Thief" -> whole, "percy jackson", "lightning thief"
 *   "Wonder (Wonder, #1)"                -> "wonder"
 *   "Holes: A Novel"                     -> "holes"
 * `simple` = no subtitle of its own, so the other title may just be this one
 * plus a subtitle ("Fireborn" vs "Fireborn: Twelve and the Frozen Forest"). */
function titleInfo(title) {
  const raw = String(title || "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  const parts = raw
    .split(/\s*[:–—]\s*|\s+-\s+|\s*\/\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !TITLE_NOISE.test(p.toLowerCase()))
    .map(titleKey)
    .filter(Boolean);
  return {
    full: titleKey(raw),
    segments: [...new Set(parts)],
    simple: parts.length <= 1,
  };
}

/* Is this the same book under a different title, edition or printing?
 * Deliberately conservative: an exact match on the whole title or on a title
 * part, and the "this one is just that one plus a subtitle" case. A shared
 * series name is NOT enough — we already own "Percy Jackson: The Lightning
 * Thief", but "Percy Jackson: The Sea of Monsters" is still a book we don't
 * have and a student may well want it. */
function sameBook(aTitle, bTitle) {
  const a = titleInfo(aTitle);
  const b = titleInfo(bTitle);
  const pairs = [[a.full, b.full]];
  a.segments.forEach((s) => pairs.push([s, b.full]));
  b.segments.forEach((s) => pairs.push([a.full, s]));
  for (const [x, y] of pairs) {
    if (x && y && x === y) return true;
  }
  if (a.simple && b.segments.includes(a.full)) return true;
  if (b.simple && a.segments.includes(b.full)) return true;
  return false;
}

/* Every ISBN a record carries (Open Library lists many per work, and the one a
 * teacher typed is often not the first). */
function isbnsOf(book) {
  const list = Array.isArray(book.isbns) && book.isbns.length ? book.isbns : [book.isbn];
  return list.map(isbnKey).filter(Boolean);
}

/* Builds both recommendation lists for a student.
 * async because the "we don't have it" list is grabbed live from Open Library
 * (see the Open Library section). Pass { refresh, exclude } to ask for a fresh
 * set of suggestions. */
async function computeRecommendations(userId, opts = {}) {
  const user = state.users.find((u) => u.id === userId);
  const answers = (state.responses || []).filter((q) => q.userId === userId);
  const empty = {
    library: [], general: [], recommendations: [], books: state.books,
    counts: { library: 0, general: 0 },
    limits: { library: 5, general: 5 },
    generalSource: { source: "none", live: false, note: "" },
  };
  if (!answers.length || !user) return empty;

  // Gather all answer data
  const prefs = {};
  answers.forEach((a) => {
    prefs[a.questionId] = a.answer;
  });

  /* 0 is a real choice ("don't show this list"); a missing setting is not. */
  const recLimit = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const libraryLimit = recLimit(state.settings.libraryRecsPerStudent, 5);
  const generalLimit = recLimit(state.settings.generalRecsPerStudent, 5);

  // ---- 1. Books on our shelves ----
  const library = rankBooks(
    state.books.filter((b) => b.approved !== false && b.inLibrary !== false),
    prefs
  ).slice(0, libraryLimit);

  // ---- 2. Books we don't have, to find elsewhere ----
  // The whole point of this list is that it is DIFFERENT from the one above, so
  // a candidate is dropped if it is a book we own — by ISBN (any printing) or by
  // title (the same book under another title, e.g. Open Library's "The
  // Lightning Thief" for our "Percy Jackson: The Lightning Thief").
  const ownedBooks = state.books.filter((b) => b.inLibrary !== false);
  const ownedIsbns = new Set();
  ownedBooks.forEach((b) => isbnsOf(b).forEach((i) => ownedIsbns.add(i)));

  const isOwned = (book) => {
    const isbns = isbnsOf(book);
    if (isbns.some((i) => ownedIsbns.has(i))) return true;
    return ownedBooks.some((o) => sameBook(o.title, book.title));
  };

  // Books the teacher marked "we don't have this" lead the list, whatever the
  // source is — they are hand-picked, and one of them may later be purchased.
  const teacherWanted = rankBooks(
    state.books.filter((b) => b.approved !== false && b.inLibrary === false),
    prefs
  );

  const chosen = [];              // titles already in the list (same-book aware)
  const isTaken = (title) => chosen.some((t) => sameBook(t, title));
  const authorsInLibrary = new Set(
    library.map((b) => String(b.author || "").toLowerCase().trim()).filter(Boolean)
  );
  const authorCount = new Map();  // so one prolific author can't fill the list
  const MAX_PER_AUTHOR = 2;

  // Picks up to `limit` books from a candidate list, dropping anything that is
  // already on this list, already on our shelves, or was waved away with the
  // "New ideas" button. Books it can't take never count against an author.
  const takeFrom = (books, { skipLibraryAuthors = false, limit = Infinity } = {}) => {
    const out = [];
    for (const b of books) {
      if (out.length >= limit) break;
      if (!b.title) continue;
      if (isTaken(b.title)) continue;                  // already on this list
      if (isOwned(b)) continue;                        // it's on our shelf
      if (excluded.some((t) => sameBook(t, b.title))) continue; // "not this one"
      const author = String(b.author || "").toLowerCase().trim();
      if (author) {
        if ((authorCount.get(author) || 0) >= MAX_PER_AUTHOR) continue;
        // Prefer books by authors we don't already have on the shelves: the two
        // lists should offer the student something new, not more of the same.
        if (skipLibraryAuthors && authorsInLibrary.has(author)) continue;
        authorCount.set(author, (authorCount.get(author) || 0) + 1);
      }
      chosen.push(b.title);
      out.push(b);
    }
    return out;
  };
  // Titles the student just said "not this one" about (the 🔄 New ideas button)
  const excluded = String(opts.exclude || "").split(",").map((t) => t.trim()).filter(Boolean);

  // What the teacher wants students to read about, then live Open Library
  // results, then the built-in pool (which always has matches to offer).
  const general = takeFrom(teacherWanted).slice(0, generalLimit);
  const wantedCount = general.length;

  const source = String(state.settings.generalSource || "openlibrary").toLowerCase();
  let live = false;
  let liveError = false;

  if (source !== "pool" && general.length < generalLimit) {
    // Only search for what this student actually likes — a broad query leaks
    // unrelated books through, and the answers are right there.
    const docs = await fetchOpenLibraryBooks(prefs, { refresh: !!opts.refresh });
    if (docs === null) liveError = true;
    else if (docs.length) {
      const olBooks = docs
        .filter(olIsAllowed)
        .map(olDocToBook)
        .filter((b) => b.title && b.author);
      // Scored exactly like our own books, so a poor match isn't shown at all.
      const ranked = rankBooks(olBooks, prefs);
      // First pass favours authors we don't already have on the shelves, so the
      // second list reads as a genuinely different set of books. If that leaves
      // the list short, a second pass allows those authors back (still capped
      // per author) rather than showing the student fewer books.
      const before = general.length;
      general.push(...takeFrom(ranked, { skipLibraryAuthors: true, limit: generalLimit - general.length }));
      if (general.length < generalLimit) {
        general.push(...takeFrom(ranked, { limit: generalLimit - general.length }));
      }
      if (general.length > before) live = true; // the list really is live now
    }
  }

  // Top up from the built-in pool: no internet, no matches, or Open Library off.
  if (general.length < generalLimit) {
    general.push(...takeFrom(rankBooks(GENERAL_BOOK_POOL, prefs), { limit: generalLimit - general.length }));
  }

  const maxScore = maxPossibleScore(prefs) || 1;
  const toRec = (b, inLibrary) => ({
    ...b,
    bookId: b.id,
    inLibrary,
    score: b.score,
    // How well this book fits, as a share of what was possible to match.
    match: Math.min(100, Math.max(5, Math.round((b.score / maxScore) * 100))),
    reason: buildReason(b, prefs),
  });

  const libraryRecs = library.map((b) => toRec(b, true));
  const generalRecs = general.map((b) => toRec(b, false));

  let note = "";
  if (source === "pool") note = "built-in list (set by your teacher)";
  else if (live) note = "live from Open Library";
  else if (liveError) note = "Open Library is offline right now — showing our saved ideas";
  else note = "our saved ideas";

  return {
    library: libraryRecs,
    general: generalRecs,
    // Kept for older callers: the whole list, shelves first.
    recommendations: [...libraryRecs, ...generalRecs],
    books: state.books,
    counts: { library: libraryRecs.length, general: generalRecs.length },
    limits: { library: libraryLimit, general: generalLimit },
    generalSource: {
      source: live ? "openlibrary" : "pool",
      live,
      teacherWanted: wantedCount,
      note,
    },
  };
}

function buildReason(book, prefs) {
  const reasons = [];
  const likedGenres = prefs.genres || [];
  const bookGenres = (book.genres || []).map((g) => g.toLowerCase());
  const matched = likedGenres.filter((g) => bookGenres.includes(g.toLowerCase()));
  if (matched.length) reasons.push(`Matches your interest in ${matched.join(", ")}`);

  const themes = prefs.themes || [];
  const bookThemes = (book.themes || []).map((t) => t.toLowerCase());
  const matchedThemes = themes.filter((t) => bookThemes.includes(t.toLowerCase()));
  if (matchedThemes.length) reasons.push(`Themes you like: ${matchedThemes.join(", ")}`);

  const mood = prefs.mood || "";
  if (mood && mood !== "No preference" && book.mood && book.mood.toLowerCase() === mood.toLowerCase()) {
    reasons.push(`${mood} mood`);
  }

  if (book.teacherPick) reasons.push("Teacher recommended");
  return reasons.join(". ") || "Great match for your preferences";
}

/* ----------------------------- HTTP server ----------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  /* ---- API routes ---- */

  // GET /api/me
  if (pathname === "/api/me" && method === "GET") {
    const sess = getSession(req, res);
    if (!sess) {
      console.log("[/api/me] No session. Cookies:", req.headers.cookie || "(none)", "X-Session-Token:", req.headers["x-session-token"] || "(none)");
      return json(res, 401, { error: "Not signed in" });
    }
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user) return json(res, 401, { error: "User not found" });
    return json(res, 200, { user: redact(user) });
  }

  // POST /api/login
  if (pathname === "/api/login" && method === "POST") {
    const body = await bodyJSON(req);
    let user;

    if (body.code) {
      // Student login with unique code only (no password required)
      user = state.users.find(
        (u) => u.role === "student" && u.code && u.code === String(body.code).toUpperCase().trim()
      );
    } else if (body.username) {
      // Admin login with username
      user = state.users.find(
        (u) => u.role === "admin" && u.username === body.username
      );
      if (user && !verifyPassword(body.password, user)) {
        user = null;
      }
    }

    if (!user) return json(res, 401, { error: "Invalid credentials" });

    const token = makeSession(user.id);
    console.log("[/api/login] Success:", user.username, "token:", token.slice(0, 12) + "...");
    // Set both an HttpOnly cookie (normal) and a readable cookie (for proxy fallback)
    res.setHeader("Set-Cookie", sessionCookieHeaders(token));
    return json(res, 200, { user: redact(user), token });
  }

  // POST /api/logout
  if (pathname === "/api/logout" && method === "POST") {
    clearSession(req);
    res.setHeader("Set-Cookie", [
      `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
      `${COOKIE}_token=; Path=/; Max-Age=0`,
    ]);
    return json(res, 200, { ok: true });
  }

  // POST /api/change-password
  if (pathname === "/api/change-password" && method === "POST") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const body = await bodyJSON(req);
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user) return json(res, 404, { error: "User not found" });

    if (user.role === "admin") {
      if (!body.oldPassword || !body.newPassword)
        return json(res, 400, { error: "Old and new password required" });
      if (!verifyPassword(body.oldPassword, user))
        return json(res, 403, { error: "Old password incorrect" });
      user.pw = hashPassword(body.newPassword);
    } else {
      // Students: just set new password (teacher can reset)
      user.password = encryptPassword(body.newPassword);
    }
    persist();
    return json(res, 200, { ok: true });
  }

  // POST /api/questionnaire
  if (pathname === "/api/questionnaire" && method === "POST") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const body = await bodyJSON(req);
    if (!body.answers || !Array.isArray(body.answers))
      return json(res, 400, { error: "Answers array required" });

    // Remove old responses for this user
    state.responses = (state.responses || []).filter(
      (q) => q.userId !== sess.userId
    );
    // Save new answers
    body.answers.forEach((a) => {
      state.responses.push({
        id: crypto.randomBytes(8).toString("hex"),
        userId: sess.userId,
        questionId: a.questionId,
        answer: a.answer,
        timestamp: Date.now(),
      });
    });
    persist();
    return json(res, 200, { ok: true });
  }

  // GET /api/questionnaire
  if (pathname === "/api/questionnaire" && method === "GET") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const questions = getQuestionnaireForStudent(sess.userId);
    const answers = (state.responses || []).filter(
      (q) => q.userId === sess.userId
    );
    const student = state.users.find((u) => u.id === sess.userId);
    const cls = student ? (state.classes || []).find((c) => c.id === student.classId) : null;
    return json(res, 200, { questions, answers, className: cls ? cls.name : "" });
  }

  // GET /api/recommendations[?refresh=1][&exclude=title,title]
  if (pathname === "/api/recommendations" && method === "GET") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    // { library: [...], general: [...], counts, limits, generalSource, books }
    // The general list is grabbed from Open Library at request time, so this
    // handler waits on it (with a timeout) — see fetchOpenLibraryBooks().
    const result = await computeRecommendations(sess.userId, {
      refresh: url.searchParams.get("refresh") === "1",
      exclude: url.searchParams.get("exclude") || "",
    });
    return json(res, 200, result);
  }

  // GET /api/state
  if (pathname === "/api/state" && method === "GET") {
    const sess = getSession(req, res);
    const safeState = JSON.parse(JSON.stringify(state));
    // Redact all user passwords
    safeState.users = safeState.users.map(redact);
    // If student, only show their own responses
    if (sess) {
      const user = state.users.find((u) => u.id === sess.userId);
      if (user && user.role === "student") {
        safeState.responses = (safeState.responses || []).filter(
          (q) => q.userId === sess.userId
        );
      }
    }
    delete safeState.settings;
    return json(res, 200, safeState);
  }

  // GET /api/openlibrary/search?q=...
  if (pathname === "/api/openlibrary/search" && method === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return json(res, 400, { error: "Query required" });
    try {
      const olUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=key,title,author_name,first_publish_year,isbn,number_of_pages_median,subject,publisher,cover_i,edition_key`;
      const olRes = await fetch(olUrl, {
        headers: { "User-Agent": "ClassroomBookRecs/1.0 (school project)" },
      });
      const data = await olRes.json();
      const results = (data.docs || []).map((doc) => ({
        title: doc.title || "",
        author: (doc.author_name || []).join(", "),
        year: doc.first_publish_year || null,
        isbn: (doc.isbn || [])[0] || "",
        pages: doc.number_of_pages_median || null,
        subjects: (doc.subject || []).slice(0, 15),
        publisher: (doc.publisher || [])[0] || "",
        coverId: doc.cover_i || null,
        coverUrl: doc.cover_i
          ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
          : "",
        openLibraryKey: doc.key || "",
      }));
      return json(res, 200, { results });
    } catch (e) {
      return json(res, 502, { error: "Open Library request failed" });
    }
  }

  // GET /api/openlibrary/work?key=/works/OL...W
  if (pathname === "/api/openlibrary/work" && method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return json(res, 400, { error: "Work key required" });
    try {
      const olRes = await fetch(`https://openlibrary.org${key}.json`, {
        headers: { "User-Agent": "ClassroomBookRecs/1.0 (school project)" },
      });
      const data = await olRes.json();
      const description =
        typeof data.description === "string"
          ? data.description
          : data.description?.value || "";
      return json(res, 200, {
        description: description.slice(0, 1000),
        subjects: (data.subjects || []).slice(0, 20),
        covers: data.covers || [],
      });
    } catch (e) {
      return json(res, 502, { error: "Open Library work request failed" });
    }
  }

  // GET /api/openlibrary/cover?isbn=...  (proxy the cover image)
  if (pathname === "/api/openlibrary/cover" && method === "GET") {
    const isbn = url.searchParams.get("isbn");
    const coverId = url.searchParams.get("coverId");
    let coverUrl;
    if (isbn) coverUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    else if (coverId) coverUrl = `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    else return json(res, 400, { error: "isbn or coverId required" });
    try {
      const olRes = await fetch(coverUrl, {
        headers: { "User-Agent": "ClassroomBookRecs/1.0 (school project)" },
        redirect: "follow",
      });
      if (!olRes.ok || olRes.headers.get("content-type")?.includes("text/html")) {
        return json(res, 404, { error: "Cover not found" });
      }
      const buf = Buffer.from(await olRes.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": olRes.headers.get("content-type") || "image/jpeg",
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=86400",
      });
      return res.end(buf);
    } catch (e) {
      return json(res, 502, { error: "Cover fetch failed" });
    }
  }

  // GET /api/settings (admin only)
  if (pathname === "/api/settings" && method === "GET") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user || user.role !== "admin")
      return json(res, 403, { error: "Admin only" });
    return json(res, 200, { settings: state.settings });
  }

  // GET /api/network (admin only) — how devices reach this server
  if (pathname === "/api/network" && method === "GET") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user || user.role !== "admin") return json(res, 403, { error: "Admin only" });
    const port = resolveListenPort();
    return json(res, 200, {
      boundHost: BIND_HOST,
      port,
      localUrl: `http://localhost:${port}`,
      lanUrls: lanUrls(port),
      // How the first URL was picked, so the teacher can trust (or override) it
      primary: primaryInfo(port),
      urlFile: path.basename(URL_FILE),
      // Anything the server found but refused to advertise as a LAN address
      interfaces: require("./deploy/lan-check.js")
        .lanAddresses()
        .map((a) => ({ name: a.name, ip: a.ip, kind: a.kind })),
      note: /^127\.|^localhost$|^::1$/.test(BIND_HOST)
        ? "Server is bound to the loopback address, so other devices cannot connect. Restart with: node server.js --host=0.0.0.0"
        : "Devices must be on the same network as this computer, use http:// (not https), and this machine's firewall must allow inbound TCP " + port + ". A LAN address never works from another site — use the tunnel/DDNS URL for that.",
    });
  }

  // POST /api/state
  if (pathname === "/api/state" && method === "POST") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const incoming = await bodyJSON(req);
    const safe = sanitizeNonAdminSave(sess, incoming);

    // Merge arrays
    ["books", "classes", "questionnaireDefs", "responses", "recommendations"].forEach((key) => {
      if (Array.isArray(safe[key])) {
        state[key] = safe[key];
      }
    });
    // Users need special handling: preserve password hashes that aren't sent to the client
    if (Array.isArray(safe.users)) {
      const currentUsers = new Map(state.users.map(u => [u.id, u]));
      state.users = safe.users.map(incoming => {
        const existing = currentUsers.get(incoming.id);
        if (!existing) return incoming; // new user
        // Preserve password fields that were redacted in GET /api/state
        const merged = { ...existing, ...incoming };
        if (existing.pw && !incoming.pw) merged.pw = existing.pw;
        if (existing.password && !incoming.password) merged.password = existing.password;
        return merged;
      });
    }
    if (safe.settings && typeof safe.settings === "object") {
      // Only admin can change settings
      const user = state.users.find((u) => u.id === sess.userId);
      if (user && user.role === "admin") {
        Object.assign(state.settings, safe.settings);
      }
    }
    persist();
    return json(res, 200, { ok: true });
  }

  // POST /api/reset
  if (pathname === "/api/reset" && method === "POST") {
    const sess = getSession(req, res);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user || user.role !== "admin")
      return json(res, 403, { error: "Admin only" });
    state = defaultState();
    seed();
    persist();
    return json(res, 200, { ok: true });
  }

  /* ---- Static file serving ---- */
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(ROOT, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";

  /* Cache policy: pages/manifest/service worker always revalidated, so a device
   * that visited from another address (localhost vs LAN IP) never keeps
   * rendering a stale shell after you update the app. */
  const noCache = ext === ".html" || ext === ".webmanifest" || /(^|\/)sw\.js$/.test(pathname);
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": noCache ? "no-cache" : "public, max-age=300",
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, headers);
    res.end(content);
  } catch (e) {
    if (e.code === "ENOENT") {
      // Serve index.html for SPA-like routes
      try {
        const fallback = fs.readFileSync(path.join(ROOT, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(fallback);
      } catch (e2) {
        res.writeHead(404);
        res.end("Not found");
      }
    } else {
      res.writeHead(500);
      res.end("Internal server error");
    }
  }
});

/* ----------------------------- seed data ------------------------------ */
function seed() {
  // Seed admin account
  if (!state.users.find((u) => u.role === "admin")) {
    state.users.push({
      id: "admin-1",
      username: "admin",
      pw: hashPassword("admin123"),
      role: "admin",
      displayName: "Teacher",
      passwordChangeRequired: true,
    });
  }

  // Seed classes
  if (!state.classes.length) {
    state.classes = [
      { id: "class-7a", name: "7A", questionnaireId: "q-7a" },
      { id: "class-7b", name: "7B", questionnaireId: "q-7b" },
      { id: "class-8a", name: "8A", questionnaireId: "q-8a" },
      { id: "class-8b", name: "8B", questionnaireId: "q-8b" },
    ];
  }

  // Seed questionnaire definitions (one per class, can be edited by teacher)
  if (!state.questionnaireDefs.length) {
    state.questionnaireDefs = [
      {
        id: "q-7a",
        name: "7A Reading Preferences",
        description: "Questionnaire for Grade 7A",
        questions: JSON.parse(JSON.stringify(DEFAULT_QUESTIONS)),
      },
      {
        id: "q-7b",
        name: "7B Reading Preferences",
        description: "Questionnaire for Grade 7B",
        questions: JSON.parse(JSON.stringify(DEFAULT_QUESTIONS)),
      },
      {
        id: "q-8a",
        name: "8A Reading Preferences",
        description: "Questionnaire for Grade 8A",
        questions: JSON.parse(JSON.stringify(DEFAULT_QUESTIONS)),
      },
      {
        id: "q-8b",
        name: "8B Reading Preferences",
        description: "Questionnaire for Grade 8B",
        questions: JSON.parse(JSON.stringify(DEFAULT_QUESTIONS)),
      },
    ];
  }

  // Seed some books
  if (state.books.length === 0) {
    const seedBooks = [
      {
        id: "book-1",
        title: "The Hobbit",
        author: "J.R.R. Tolkien",
        genres: ["Fantasy", "Adventure"],
        themes: ["Friendship", "Coming of age", "Magic & Supernatural"],
        mood: "Action-packed",
        setting: "Medieval / old times",
        pace: "mixed",
        difficulty: "medium",
        pages: 310,
        description: "Bilbo Baggins, a comfortable hobbit, is swept into an epic quest to reclaim a stolen treasure from a dragon.",
        coverUrl: "",
        isbn: "978-0547928227",
        approved: true,
        teacherPick: true,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-2",
        title: "Percy Jackson: The Lightning Thief",
        author: "Rick Riordan",
        genres: ["Fantasy", "Adventure", "Humor"],
        themes: ["Family", "Identity", "Coming of age", "Magic & Supernatural"],
        mood: "Light and fun",
        setting: "Modern day",
        pace: "fast",
        difficulty: "easy",
        pages: 377,
        description: "Percy discovers he's the son of Poseidon and must find Zeus's stolen lightning bolt to prevent a war among the gods.",
        coverUrl: "",
        isbn: "978-0786838653",
        approved: true,
        teacherPick: true,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-3",
        title: "Wonder",
        author: "R.J. Palacio",
        genres: ["Realistic Fiction"],
        themes: ["Friendship", "Family", "Identity", "Coming of age"],
        mood: "Emotional and heartfelt",
        setting: "Modern day",
        pace: "slow",
        difficulty: "easy",
        pages: 315,
        description: "Auggie Pullman, born with severe facial deformities, enters mainstream school for the first time in fifth grade.",
        coverUrl: "",
        isbn: "978-0375869020",
        approved: true,
        teacherPick: true,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-4",
        title: "The Giver",
        author: "Lois Lowry",
        genres: ["Sci-Fi", "Realistic Fiction"],
        themes: ["Identity", "Justice", "Coming of age"],
        mood: "Thought-provoking",
        setting: "Futuristic / space",
        pace: "slow",
        difficulty: "medium",
        pages: 208,
        description: "In a seemingly utopian society, Jonas is assigned to receive memories of the past and discovers the dark truth beneath the surface.",
        coverUrl: "",
        isbn: "978-0544336261",
        approved: true,
        teacherPick: false,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-5",
        title: "Hatchet",
        author: "Gary Paulsen",
        genres: ["Adventure", "Realistic Fiction"],
        themes: ["Survival", "Nature", "Coming of age"],
        mood: "Action-packed",
        setting: "Wilderness / nature",
        pace: "mixed",
        difficulty: "easy",
        pages: 195,
        description: "After a plane crash, thirteen-year-old Brian must survive alone in the Canadian wilderness with only a hatchet.",
        coverUrl: "",
        isbn: "978-1416936473",
        approved: true,
        teacherPick: false,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-6",
        title: "A Wrinkle in Time",
        author: "Madeleine L'Engle",
        genres: ["Sci-Fi", "Fantasy", "Adventure"],
        themes: ["Family", "Good vs Evil", "Science"],
        mood: "Thought-provoking",
        setting: "Another world / fantasy realm",
        pace: "fast",
        difficulty: "medium",
        pages: 256,
        description: "Meg Murry travels through space and time to rescue her father, aided by three mysterious celestial beings.",
        coverUrl: "",
        isbn: "978-0312367541",
        approved: true,
        teacherPick: false,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-7",
        title: "Diary of a Wimpy Kid",
        author: "Jeff Kinney",
        genres: ["Humor", "Realistic Fiction", "Graphic Novels"],
        themes: ["Friendship", "Family", "Coming of age"],
        mood: "Light and fun",
        setting: "Modern day",
        pace: "fast",
        difficulty: "easy",
        pages: 224,
        description: "Greg Heffley navigates the treacherous landscape of middle school, documented in his diary with hilarious illustrations.",
        coverUrl: "",
        isbn: "978-0810993136",
        approved: true,
        teacherPick: false,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-8",
        title: "The Outsiders",
        author: "S.E. Hinton",
        genres: ["Realistic Fiction"],
        themes: ["Friendship", "Identity", "Social Issues", "Coming of age"],
        mood: "Dark and intense",
        setting: "Modern day",
        pace: "mixed",
        difficulty: "medium",
        pages: 192,
        description: "Ponyboy Curtis navigates life as a Greaser, caught in a bitter rivalry with the wealthy Socs.",
        coverUrl: "",
        isbn: "978-0142407332",
        approved: true,
        teacherPick: true,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-9",
        title: "Holes",
        author: "Louis Sachar",
        genres: ["Adventure", "Mystery", "Humor"],
        themes: ["Justice", "Friendship", "Survival"],
        mood: "Thought-provoking",
        setting: "Wilderness / nature",
        pace: "mixed",
        difficulty: "easy",
        pages: 233,
        description: "Stanley Yelnats is sent to a brutal juvenile detention camp where boys dig holes daily, uncovering a mystery spanning generations.",
        coverUrl: "",
        isbn: "978-0440419464",
        approved: true,
        teacherPick: true,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-10",
        title: "Number the Stars",
        author: "Lois Lowry",
        genres: ["Historical Fiction"],
        themes: ["Friendship", "Family", "War & Conflict", "Survival"],
        mood: "Emotional and heartfelt",
        setting: "Medieval / old times",
        pace: "fast",
        difficulty: "easy",
        pages: 137,
        description: "During WWII, ten-year-old Annemarie helps smuggle her Jewish best friend out of Nazi-occupied Denmark.",
        coverUrl: "",
        isbn: "978-0547577098",
        approved: true,
        teacherPick: false,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-11",
        title: "Ender's Game",
        author: "Orson Scott Card",
        genres: ["Sci-Fi", "Adventure"],
        themes: ["Technology", "War & Conflict", "Identity"],
        mood: "Thought-provoking",
        setting: "Futuristic / space",
        pace: "fast",
        difficulty: "hard",
        pages: 324,
        description: "Child prodigy Ender Wiggin is recruited to military school in space to prepare for an alien invasion.",
        coverUrl: "",
        isbn: "978-0812550702",
        approved: true,
        teacherPick: false,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
      {
        id: "book-12",
        title: "Ghost Boys",
        author: "Jewell Parker Rhodes",
        genres: ["Realistic Fiction"],
        themes: ["Justice", "Social Issues", "Identity", "Family"],
        mood: "Emotional and heartfelt",
        setting: "Modern day",
        pace: "slow",
        difficulty: "medium",
        pages: 192,
        description: "After being shot by a police officer, twelve-year-old Jerome's ghost witnesses the aftermath and meets the ghost of Emmett Till.",
        coverUrl: "",
        isbn: "978-0316262286",
        approved: true,
        teacherPick: true,
        addedBy: "admin-1",
        addedAt: Date.now(),
      },
    ];
    state.books = seedBooks;
  }
}

/* ---- LAN addresses (the URLs other devices actually type) ----
 * Detection lives in deploy/lan-check.js: it asks the OS routing table which
 * interface carries the default route, so a VirtualBox/WSL adapter can't win.
 * Pin the advertised address with BOOKRECS_LAN_IP=192.168.1.50 if you know
 * better than the router (NAT, reverse proxy, cloud public IP).            */
function lanUrls(port) {
  return require("./deploy/lan-check.js").lanUrls(port);
}
function primaryInfo(port) {
  return require("./deploy/lan-check.js").primaryInfo(port);
}

/* Keep a file with the current LAN URL so you can grab the address any time —
 * it's the first line, no comments, so `head -1 bookrecs-url.txt` works.   */
function writeLanUrlFile(port) {
  try {
    const urls = lanUrls(port);
    const prim = primaryInfo(port);
    const body =
      (urls[0] || `http://localhost:${port}`) +
      "\n\n" +
      "# Classroom Book Recs — addresses other devices can use (do not share publicly)\n" +
      `# updated: ${new Date().toISOString()}\n` +
      `# port:    ${port}   bound to: ${BIND_HOST}\n` +
      `# on this computer: http://localhost:${port}\n` +
      (urls.length
        ? urls
            .map((u, i) => {
              const where = !i && prim.iface ? (prim.iface === "pinned" ? "pinned address" : prim.iface) : "";
              return `# device ${i + 1}:     ${u}${where ? `   (${where})` : ""}`;
            })
            .join("\n") + "\n"
        : "# no usable LAN address found — see HOSTING.md, Option C\n") +
      (urls.length > 1 ? "# (multiple adapters: use the one on the students' network)\n" : "");
    fs.writeFileSync(URL_FILE, body);
    return body;
  } catch (e) {
    return "";
  }
}

/* Print the friendly startup banner */
function printBanner(port, savedPort) {
  const line = "─".repeat(52);
  console.log(`\n  📚  Classroom Book Recommendations`);
  console.log(`  ${line}`);
  console.log(`  Listening on ${BIND_HOST}:${port}`);
  if (savedPort && savedPort !== port) {
    const why =
      FLAGS.port && port === FLAGS.port ? "--port flag"
      : process.env.PORT || process.env.BOOKRECS_PORT ? "PORT env var"
      : "the built-in default";
    console.log(`  (the saved admin setting says port ${savedPort}, but ${why} wins → use ${port})`);
  }
  console.log("");
  console.log(`  This computer:   http://localhost:${port}`);
  const loopbackOnly = /^(127\.|localhost$|::1$|\[::1\]$)/.test(BIND_HOST);
  const prim = primaryInfo(port);
  const urls = loopbackOnly ? [] : lanUrls(port);
  const ifAddrs = require("./deploy/lan-check.js").lanAddresses();
  if (loopbackOnly) {
    console.log(`  Other devices:   ✗ blocked — bound to ${BIND_HOST} (this computer only)`);
    console.log(`                   use  node server.js --host=0.0.0.0  to serve the LAN`);
  } else if (urls.length) {
    const how = prim.via === "BOOKRECS_LAN_IP" ? "pinned via BOOKRECS_LAN_IP" : `auto-detected · ${prim.iface || "?"} · ${prim.via || "default route"}`;
    console.log(`  Other devices:   ${urls[0]}   ← use THIS on phones/laptops`);
    console.log(`                   (${how})`);
    urls.slice(1).forEach((u) => console.log(`                   ${u}`));
    console.log(`                   (also saved to ${path.basename(URL_FILE)})`);
  } else if (ifAddrs.length) {
    const why = (a) =>
      a.kind === "apipa" ? "no DHCP lease — reconnect the network"
      : a.kind === "public" ? "public address, not a LAN IP"
      : a.kind === "cgnat" ? "CGNAT/Tailscale range" : a.kind;
    console.log(`  Other devices:   no usable LAN address; found:`);
    ifAddrs.forEach((a) => console.log(`                   ${a.ip} (${a.name}) — ${why(a)}`));
    console.log(`                   Try again after the network connects (a phone hotspot works),`);
    console.log(`                   or pin the address:  BOOKRECS_LAN_IP=192.168.1.50 node server.js`);
  } else {
    console.log(`  Other devices:   no LAN IPv4 adapter found on this machine`);
    console.log(`                   (container/VM? publish the port, or use a tunnel)`);
  }
  console.log("");
  console.log(`  Note: "0.0.0.0" is the bind address, not a URL — never type`);
  console.log(`        http://0.0.0.0:${port} or http://localhost:${port} on another device.`);
  console.log(`  "http://", not https. Both devices must be on the SAME network.`);
  console.log("");
  console.log(`  Admin login:  username "admin" / password "admin123"`);
  console.log(`  Students log in with a unique code (teacher assigns)`);
  console.log(`\n  Nothing loading on another device?  run:  node deploy/lan-check.js\n`);
}

/* ----------------------------- start ----------------------------------- */
loadData();
loadSessions(); // keep everyone signed in across a restart
seed();
persist();

if (FLAGS.help) {
  console.log(`
  Classroom Book Recommendations server

    node server.js                    listen on 0.0.0.0:8080, print the LAN URL
    node server.js --port=9090        use another port (or PORT=9090)
    node server.js --host=127.0.0.1   this computer only (default: everyone on the LAN)
    node server.js --print-url        print the one URL devices should use, then exit
    node server.js --open             also open the app in this computer's browser
    node server.js --lan-check        diagnose "other devices can't reach the LAN IP"
    node server.js --lan-check --port=8080

  The LAN address is found automatically from the OS routing table (the interface
  with the default route), refreshed while the server runs, and written to
  bookrecs-url.txt. Pin it with BOOKRECS_LAN_IP=192.168.1.50 if you must.
  See HOSTING.md for firewall + reachability.
`);
  process.exit(0);
}

if (FLAGS.printUrl) {
  const port = resolveListenPort();
  const { bestUrl } = require("./deploy/lan-check.js");
  const url = bestUrl(port);
  // Exit 1 when there's no LAN address, so scripts can branch on it.
  console.log(url || `http://localhost:${port}`);
  process.exit(url ? 0 : 1);
}

if (FLAGS.lanCheck) {
  // Diagnostics only — report, then exit without serving.
  require("./deploy/lan-check.js")
    .run({ port: resolveListenPort(), host: BIND_HOST })
    .catch((e) => {
      console.error("  lan-check failed:", (e && e.message) || e);
      process.exitCode = 1;
    })
    .then(() => process.exit(process.exitCode || 0));
} else {
  startServer();
}

/* Best-effort "open it for me" on the host machine — never fatal. */
function openBrowser(url) {
  const { spawn } = require("child_process");
  const platform = process.platform;
  const [bin, args] =
    platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.on("error", () => console.log(`  (couldn't open a browser — go to ${url})`));
    child.unref();
  } catch (e) {
    console.log(`  (couldn't open a browser — go to ${url})`);
  }
}

function startServer() {
  const LISTEN_PORT = resolveListenPort();
  const SAVED_PORT = Number(state.settings && state.settings.port) || 0;
  let lastBestUrl = "";

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  ✗ Could not start: port ${LISTEN_PORT} is already in use on ${BIND_HOST}.\n`);
      console.error(`    Most likely another copy of this server (or another app) is already running.`);
      console.error(`    Fix it with ONE of these:\n`);
      console.error(`      · Just use the running one → open ${lanUrls(LISTEN_PORT)[0] || `http://localhost:${LISTEN_PORT}`}`);
      console.error(`      · Pick a different port    → node server.js --port=9090`);
      console.error(`      · Find / stop the holder   → Windows:  netstat -ano | findstr :${LISTEN_PORT}`);
      console.error(`                                   macOS/Linux: lsof -i :${LISTEN_PORT} -sTCP:LISTEN\n`);
    } else if (err.code === "EACCES") {
      console.error(`\n  ✗ Permission denied binding ${BIND_HOST}:${LISTEN_PORT}.`);
      console.error(`    Ports under 1024 need root. Either run the app on 8080 and put`);
      console.error(`    Caddy/a tunnel in front of it, or start with sudo (not recommended).\n`);
    } else {
      console.error(`\n  ✗ Server error: ${err.code || ""} ${err.message}\n`);
    }
    process.exit(1);
  });

  server.listen(LISTEN_PORT, BIND_HOST, () => {
    printBanner(LISTEN_PORT, SAVED_PORT);
    writeLanUrlFile(LISTEN_PORT);
    lastBestUrl = lanUrls(LISTEN_PORT)[0] || "";
    if (FLAGS.open) openBrowser(`http://localhost:${LISTEN_PORT}`);
    watchLanAddress(LISTEN_PORT);
  });

  /* Wi-Fi re-leases, dongles come and go, laptops move between networks — so
   * re-check quietly and shout (and rewrite the URL file) only on a change. */
  function watchLanAddress(port) {
    if (/^(127\.|localhost$|::1$|\[::1\]$)/.test(BIND_HOST)) return; // loopback-only
    const tick = () => {
      try {
        require("./deploy/lan-check.js").refreshNetwork();
        const best = lanUrls(port)[0] || "";
        if (best !== lastBestUrl) {
          const was = lastBestUrl;
          lastBestUrl = best;
          writeLanUrlFile(port);
          console.log(
            `  ↻ LAN address ${was ? "changed" : "found"} → ${best || "none (network down?)"}${
              best ? "   ← tell devices to use this one" : ""
            }`
          );
        }
      } catch (e) {
        /* never let a network hiccup take the server down */
      }
    };
    const timer = setInterval(tick, 20000);
    if (timer.unref) timer.unref();
  }
}

