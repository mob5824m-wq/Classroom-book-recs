/* ============================================================
 * js/app.js — Shared utilities for Book Recommendations
 * ============================================================ */

const App = (() => {
  let me = null;
  let state = null;
  /* Auth bookkeeping.
   * authResolved = we have asked the server who we are at least once, so
   * "no user" is a real answer and not just "we don't know yet". The nav uses
   * it to avoid drawing a signed-out header over a signed-in page.        */
  let authResolved = false;
  let mePromise = null;   // in-flight /api/me, shared between callers
  let navPage = "";       // last page handed to renderNav, so we can repaint

  /* ---- toast ---- */
  function toast(msg, type = "info") {
    let container = document.querySelector(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  /* ---- token helpers ---- */
  function storeToken(token) {
    if (!token) return;
    localStorage.setItem("bookrecs_token", token);
    // Also set a readable cookie (backup for environments where localStorage headers get stripped)
    document.cookie = `bookrecs_session_token=${token}; Path=/; SameSite=Lax; Max-Age=${6 * 3600}`;
  }

  function clearToken() {
    localStorage.removeItem("bookrecs_token");
    document.cookie = "bookrecs_session_token=; Path=/; Max-Age=0";
  }

  function getToken() {
    // Try localStorage first, then readable cookie
    let token = localStorage.getItem("bookrecs_token");
    if (!token) {
      const match = document.cookie.match(/bookrecs_session_token=([a-f0-9]+)/);
      if (match) token = match[1];
    }
    return token;
  }

  /* ---- fetch helpers ---- */
  async function api(url, opts = {}) {
    try {
      const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
      const token = getToken();
      if (token) {
        headers["X-Session-Token"] = token;
      } else {
        console.warn("[BookRecs] No session token found for", url);
      }
      console.log("[BookRecs] API:", url, token ? "(token: " + token.slice(0,8) + "...)" : "(no token)");
      const res = await fetch(url, { ...opts, headers, credentials: "same-origin" });
      console.log("[BookRecs] API response:", url, res.status);
      const data = await res.json();
      if (res.status === 401) {
        console.warn("[BookRecs] 401 Unauthorized for", url);
        clearToken();
        throw new Error(data.error || "Not signed in");
      }
      if (data.token) {
        console.log("[BookRecs] Token received, storing...");
        storeToken(data.token);
      }
      if (!res.ok) {
        const errorMsg = data.error || "Request failed";
        toast(errorMsg, "error");
        throw new Error(errorMsg);
      }
      return data;
    } catch (e) {
      console.error("[BookRecs] API error:", url, e.message);
      if (!e.message || e.message === "Failed to fetch") {
        toast("Could not connect to server", "error");
      }
      throw e;
    }
  }

  async function getState() {
    const data = await api("/api/state");
    state = data;
    return data;
  }

  async function postState(updates) {
    return api("/api/state", {
      method: "POST",
      body: JSON.stringify(updates),
    });
  }

  async function getMe() {
    // Share one request: pages call this from several places (auth guard,
    // nav, hero) and each new page load asks again.
    if (mePromise) return mePromise;
    mePromise = (async () => {
      try {
        // One retry: a dropped request on a flaky classroom Wi-Fi is not a
        // signed-out student, and getting this wrong signs them out visually.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const headers = { "Content-Type": "application/json" };
            const token = getToken();
            if (token) headers["X-Session-Token"] = token;
            const res = await fetch("/api/me", { headers, credentials: "same-origin" });
            if (res.status === 401) { me = null; return null; }
            if (!res.ok) throw new Error("auth check failed: " + res.status);
            const data = await res.json();
            if (data.token) storeToken(data.token);
            me = data.user;
            return me;
          } catch (e) {
            if (attempt === 1) { me = null; return null; }
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        me = null;
        return null;
      } finally {
        authResolved = true;
        mePromise = null;
        // Repaint the header now that the real session is known. Without this
        // a page that renders its nav early (e.g. Home) keeps showing
        // "Sign In" to a student who is still signed in.
        renderNav(navPage);
      }
    })();
    return mePromise;
  }

  async function login(code, password, username) {
    const body = username ? { username, password } : { code, password };
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Login failed", "error");
      throw new Error(data.error);
    }
    me = data.user;
    authResolved = true;
    // Store session token for proxy environments where cookies get stripped
    if (data.token) {
      storeToken(data.token);
      console.log("[BookRecs] Session token stored");
    } else {
      console.warn("[BookRecs] No token in login response");
    }
    renderNav(navPage);
    return me;
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch (e) { /* sign out locally even if the server call fails */ }
    clearToken();
    me = null;
    authResolved = true;
    renderNav(navPage);
    window.location.href = "/";
  }

  /* ---- nav bar ---- */
  function renderNav(activePage) {
    const bar = document.querySelector(".top-bar");
    if (!bar) return;
    if (typeof activePage === "string" && activePage) navPage = activePage;

    const isStudent = me && me.role === "student";
    const isAdmin = me && me.role === "admin";

    let links = '<a href="/" class="' + (navPage === "home" ? "active" : "") + '">Home</a>';
    if (me) {
      links += '<a href="/catalog.html" class="' + (navPage === "catalog" ? "active" : "") + '">Catalog</a>';
      if (isStudent) {
        links += '<a href="/questionnaire.html" class="' + (navPage === "questionnaire" ? "active" : "") + '">My Tastes</a>';
        links += '<a href="/recommendations.html" class="' + (navPage === "recommendations" ? "active" : "") + '">For Me</a>';
      }
      if (isAdmin) {
        links += '<a href="/admin.html" class="' + (navPage === "admin" ? "active" : "") + '">Teacher</a>';
      }
    }

    const name = me ? (me.displayName || me.username || me.code) : "";
    const role = me ? me.role : "";
    let userHtml = "";
    if (me) {
      userHtml = `<span class="user-badge">${role}</span>
         <span>${name}</span>
         <button class="btn btn-sm btn-outline" style="color:#fff;border-color:rgba(255,255,255,.5)" onclick="App.logout()">Sign Out</button>`;
    } else if (authResolved) {
      userHtml = `<a href="/login.html" class="btn btn-sm btn-outline" style="color:#fff;border-color:rgba(255,255,255,.5)">Sign In</a>`;
    }
    // If we don't know yet, leave the user area empty for a moment instead of
    // claiming the visitor is signed out — see the "Sign In" flash on Home.

    bar.innerHTML = `
      <div class="logo"><span>📚</span> Book Recs</div>
      <button class="hamburger" onclick="this.nextElementSibling.classList.toggle('open')">☰</button>
      <nav>${links}</nav>
      <div class="user-info">${userHtml}</div>
    `;

    // First paint on any page: find out whether there is a session, then repaint.
    if (!authResolved && !mePromise) getMe();
  }

  /* ---- clipboard ----
   * navigator.clipboard only exists in a secure context, and the usual way to
   * reach this app is plain http://<LAN-IP>:8080 — so keep a fallback. */
  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function copyText(text, okMsg) {
    if (await writeClipboard(text)) toast(okMsg || "Copied", "success");
    else toast("Couldn't copy — select the text and copy it by hand", "error");
  }

  /* ---- auth guard ---- */
  async function requireAuth(allowedRoles) {
    // getMe() already retries a transient failure itself.
    const user = await getMe();
    if (!user) {
      console.warn("[BookRecs] Auth failed, redirecting to login");
      window.location.href = "/login.html";
      return null;
    }
    if (allowedRoles && !allowedRoles.includes(user.role)) {
      toast("Access denied", "error");
      window.location.href = "/";
      return null;
    }
    console.log("[BookRecs] Auth OK:", user.username, user.role);
    // Re-render nav now that we know who the user is
    renderNav(document.body.dataset.activePage || "");
    return user;
  }

  /* ---- dark mode ---- */
  function initDarkMode() {
    const pref = localStorage.getItem("bookrecs_dark");
    if (pref === "true") document.body.classList.add("dark");
  }

  function toggleDarkMode() {
    document.body.classList.toggle("dark");
    localStorage.setItem(
      "bookrecs_dark",
      document.body.classList.contains("dark")
    );
  }

  /* ---- public API ---- */
  return {
    toast,
    api,
    getState,
    postState,
    getMe,
    login,
    logout,
    renderNav,
    requireAuth,
    copyText,
    initDarkMode,
    toggleDarkMode,
    getToken,
    storeToken,
    clearToken,
    get me() { return me; },
    get state() { return state; },
  };
})();

// Auto-init
document.addEventListener("DOMContentLoaded", () => {
  // Check for token passed via URL hash (proxy-safe auth handoff)
  const hash = window.location.hash;
  if (hash && hash.startsWith("#token=")) {
    const token = hash.replace("#token=", "");
    if (token && token.length > 10) {
      console.log("[BookRecs] Token found in URL hash, storing...");
      localStorage.setItem("bookrecs_token", token);
      document.cookie = `bookrecs_session_token=${token}; Path=/; SameSite=Lax; Max-Age=${6 * 3600}`;
      // Clean the URL hash (don't leave token visible)
      history.replaceState(null, "", window.location.pathname);
    }
  }
  App.initDarkMode();
});
