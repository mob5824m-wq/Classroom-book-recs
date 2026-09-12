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

/* ---- CLI flags: --port=NNNN, --host=0.0.0.0, --lan-check, --help ---- */
const FLAGS = parseFlags(process.argv.slice(2));
function parseFlags(argv) {
  const out = { port: 0, host: "", lanCheck: false, help: false };
  argv.forEach((arg) => {
    const port = arg.match(/^--port=(\d+)$/);
    const host = arg.match(/^--host=(.+)$/);
    if (port) out.port = parseInt(port[1], 10);
    else if (host) out.host = host[1];
    else if (arg === "--lan-check" || arg === "--lan-info" || arg === "lan-check")
      out.lanCheck = true;
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

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    const obj = JSON.parse(raw);
    Object.keys(obj).forEach((token) => sessions.set(token, obj[token]));
  } catch (e) { /* no file yet */ }
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
      maxRecsPerStudent: 10,
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

function getSession(req) {
  // Try multiple sources for the session token:
  // 1. HttpOnly cookie (primary)
  // 2. Regular readable cookie (proxy fallback)
  // 3. X-Session-Token header (JavaScript localStorage fallback)
  const cookies = req.headers.cookie || "";
  const httpOnlyMatch = cookies.match(new RegExp(`${COOKIE}=([a-f0-9]+)`));
  const regularMatch = cookies.match(new RegExp(`${COOKIE}_token=([a-f0-9]+)`));
  const headerToken = req.headers["x-session-token"];
  const token = (httpOnlyMatch && httpOnlyMatch[1]) || (regularMatch && regularMatch[1]) || headerToken;
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  const now = Date.now();
  if (now - sess.lastActive > SESSION_TTL) {
    sessions.delete(token);
    persistSessions();
    return null;
  }
  if (now - sess.created > SESSION_ABS_MAX) {
    sessions.delete(token);
    persistSessions();
    return null;
  }
  sess.lastActive = now;
  persistSessions();
  return { token, ...sess };
}

function clearSession(req) {
  const cookie = (req.headers.cookie || "").match(
    new RegExp(COOKIE + "=([a-f0-9]+)")
  );
  if (cookie) {
    sessions.delete(cookie[1]);
    persistSessions();
  }
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

function computeRecommendations(userId) {
  const user = state.users.find((u) => u.id === userId);
  const answers = (state.responses || []).filter((q) => q.userId === userId);
  if (!answers.length || !user) return [];

  // Gather all answer data
  const prefs = {};
  answers.forEach((a) => {
    prefs[a.questionId] = a.answer;
  });

  const likedGenres = prefs.genres || [];
  const themes = prefs.themes || [];
  const mood = prefs.mood || "";
  const bookLength = prefs.book_length || "";
  const readingLevel = prefs.reading_level || "";
  const settingPref = prefs.setting_pref || [];
  const characterPref = prefs.character_pref || "";
  const pacePref = prefs.pace_pref || "";
  const seriesPref = prefs.series_pref || "";
  const avoidPref = prefs.avoid_pref || [];

  // Score each book
  const scored = state.books
    .filter((b) => b.approved !== false) // only teacher-approved books
    .map((book) => {
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

      return { ...book, score };
    })
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score);

  const maxRecs = state.settings.maxRecsPerStudent || 10;
  return scored.slice(0, maxRecs).map((b) => ({
    bookId: b.id,
    score: b.score,
    reason: buildReason(b, prefs),
  }));
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
    const sess = getSession(req);
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
    res.setHeader("Set-Cookie", [
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
      `${COOKIE}_token=${token}; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
    ]);
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
    const sess = getSession(req);
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
    const sess = getSession(req);
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
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const questions = getQuestionnaireForStudent(sess.userId);
    const answers = (state.responses || []).filter(
      (q) => q.userId === sess.userId
    );
    const student = state.users.find((u) => u.id === sess.userId);
    const cls = student ? (state.classes || []).find((c) => c.id === student.classId) : null;
    return json(res, 200, { questions, answers, className: cls ? cls.name : "" });
  }

  // GET /api/recommendations
  if (pathname === "/api/recommendations" && method === "GET") {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const recs = computeRecommendations(sess.userId);
    return json(res, 200, { recommendations: recs, books: state.books });
  }

  // GET /api/state
  if (pathname === "/api/state" && method === "GET") {
    const sess = getSession(req);
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
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user || user.role !== "admin")
      return json(res, 403, { error: "Admin only" });
    return json(res, 200, { settings: state.settings });
  }

  // GET /api/network (admin only) — how devices reach this server
  if (pathname === "/api/network" && method === "GET") {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: "Not signed in" });
    const user = state.users.find((u) => u.id === sess.userId);
    if (!user || user.role !== "admin") return json(res, 403, { error: "Admin only" });
    const port = resolveListenPort();
    return json(res, 200, {
      boundHost: BIND_HOST,
      port,
      localUrl: `http://localhost:${port}`,
      lanUrls: lanUrls(port),
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
    const sess = getSession(req);
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
    const sess = getSession(req);
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

/* ---- LAN addresses (the URLs other devices actually type) ---- */
function lanUrls(port) {
  return require("./deploy/lan-check.js").lanUrls(port);
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
  const urls = loopbackOnly ? [] : lanUrls(port);
  const ifAddrs = require("./deploy/lan-check.js").lanAddresses();
  if (loopbackOnly) {
    console.log(`  Other devices:   ✗ blocked — bound to ${BIND_HOST} (this computer only)`);
    console.log(`                   use  node server.js --host=0.0.0.0  to serve the LAN`);
  } else if (urls.length) {
    console.log(`  Other devices:   ${urls[0]}   ← use THIS on phones/laptops`);
    urls.slice(1).forEach((u) => console.log(`                   ${u}`));
  } else if (ifAddrs.length) {
    const why = (a) =>
      a.kind === "apipa" ? "no DHCP lease — reconnect the network"
      : a.kind === "public" ? "public address, not a LAN IP"
      : a.kind === "cgnat" ? "CGNAT/Tailscale range" : a.kind;
    console.log(`  Other devices:   no usable LAN address; found:`);
    ifAddrs.forEach((a) => console.log(`                   ${a.ip} (${a.name}) — ${why(a)}`));
    console.log(`                   Try again after the network connects (a phone hotspot works).`);
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
seed();
persist();

if (FLAGS.help) {
  console.log(`
  Classroom Book Recommendations server

    node server.js                    listen on 0.0.0.0:8080
    node server.js --port=9090        use another port (or PORT=9090)
    node server.js --host=127.0.0.1   this computer only (default: everyone on the LAN)
    node server.js --lan-check        diagnose "other devices can't reach the LAN IP"
    node server.js --lan-check --port=8080

  LAN URLs for other devices are printed at startup. See HOSTING.md.
`);
  process.exit(0);
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

function startServer() {
  const LISTEN_PORT = resolveListenPort();
  const SAVED_PORT = Number(state.settings && state.settings.port) || 0;

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

  server.listen(LISTEN_PORT, BIND_HOST, () => printBanner(LISTEN_PORT, SAVED_PORT));
}

