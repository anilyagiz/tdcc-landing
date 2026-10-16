// Shared client for the GPU marketplace pages: API calls, escaping, the
// sign-in / sign-up dialog, toasts, and the nav account link.
(() => {
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ago = (ts) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };

  async function api(method, path, body) {
    const opts = { method, credentials: "same-origin", headers: { accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw Object.assign(new Error("Could not reach the server. Check your connection and try again."), { status: 0 });
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = data.error || (res.status === 404 ? "The marketplace service is not available on this deployment yet." : `Request failed (${res.status}).`);
      throw Object.assign(new Error(msg), { status: res.status, field: data.field });
    }
    return data;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle("bad", bad);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 4200 : 2600);
  }

  // ---------- current user ----------
  let mePromise = null;
  const listeners = new Set();
  function me(refresh = false) {
    if (!mePromise || refresh) mePromise = api("GET", "/api/me").then((d) => d.user).catch(() => null);
    return mePromise;
  }
  function setUser(user) {
    mePromise = Promise.resolve(user);
    listeners.forEach((fn) => fn(user));
  }
  const onUser = (fn) => { listeners.add(fn); me().then(fn); };

  async function logout() {
    try { await api("POST", "/api/auth/logout", {}); } catch { /* cookie is cleared server-side anyway */ }
    setUser(null);
  }

  // ---------- auth dialog ----------
  let dlg, resolveAuth, lastFocus;
  function buildDialog() {
    dlg = document.createElement("div");
    dlg.className = "modal";
    dlg.id = "auth";
    dlg.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="auth-title" tabindex="-1">
        <div class="modal-head">
          <div><h2 id="auth-title">Sign in</h2><p id="auth-reason"></p></div>
          <button class="modal-x" type="button" data-auth-close aria-label="Close">×</button>
        </div>
        <form class="modal-body" id="auth-form" novalidate>
          <div class="tabs" role="tablist">
            <button type="button" role="tab" data-tab="login" aria-selected="true">Sign in</button>
            <button type="button" role="tab" data-tab="signup" aria-selected="false">Create account</button>
          </div>
          <div class="form-err" id="auth-err" role="alert"></div>
          <label class="fl" data-only="signup" hidden>Your name<input class="inp" name="name" autocomplete="name" maxlength="80" /></label>
          <label class="fl">Email<input class="inp" name="email" type="email" autocomplete="email" maxlength="254" required /></label>
          <label class="fl">Password<input class="inp" name="password" type="password" autocomplete="current-password" minlength="10" maxlength="200" required />
            <small data-only="signup" hidden>At least 10 characters. A short sentence works well.</small></label>
          <label class="check" data-only="signup" hidden><input type="checkbox" name="accept_terms" /> <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">privacy policy</a>.</span></label>
          <button class="btn solid" type="submit" id="auth-submit">Sign in →</button>
        </form>
      </div>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("#auth-form");
    let mode = "login";
    const setMode = (m) => {
      mode = m;
      dlg.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === m)));
      dlg.querySelectorAll("[data-only=signup]").forEach((el) => { el.hidden = m !== "signup"; });
      dlg.querySelector("#auth-title").textContent = m === "signup" ? "Create your account" : "Sign in";
      dlg.querySelector("#auth-submit").textContent = m === "signup" ? "Create account →" : "Sign in →";
      form.password.autocomplete = m === "signup" ? "new-password" : "current-password";
      showErr("");
    };
    const showErr = (msg, field) => {
      const e = dlg.querySelector("#auth-err");
      e.textContent = msg; e.classList.toggle("show", !!msg);
      form.querySelectorAll(".inp").forEach((i) => i.removeAttribute("aria-invalid"));
      if (field && form[field]) { form[field].setAttribute("aria-invalid", "true"); form[field].focus(); }
    };
    dlg.setMode = setMode;
    dlg.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.tab)));
    dlg.querySelectorAll("[data-auth-close]").forEach((b) => b.addEventListener("click", () => closeAuth(null)));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeAuth(null); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg.classList.contains("open")) closeAuth(null); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = dlg.querySelector("#auth-submit");
      const body = { email: form.email.value.trim(), password: form.password.value };
      if (!body.email || !body.password) return showErr("Enter your email and password.", !body.email ? "email" : "password");
      if (mode === "signup") {
        body.name = form.name.value.trim();
        body.accept_terms = form.accept_terms.checked;
        if (!body.name) return showErr("Tell us your name.", "name");
        if (body.password.length < 10) return showErr("Use at least 10 characters for your password.", "password");
        if (!body.accept_terms) return showErr("Please accept the terms to continue.");
      }
      btn.disabled = true;
      try {
        const d = await api("POST", mode === "signup" ? "/api/auth/signup" : "/api/auth/login", body);
        form.reset();
        setUser(d.user);
        toast(mode === "signup" ? `Welcome, ${d.user.name.split(" ")[0]}` : "Signed in");
        closeAuth(d.user);
      } catch (err) {
        showErr(err.message, err.field);
      } finally {
        btn.disabled = false;
      }
    });
  }
  function closeAuth(user) {
    dlg.classList.remove("open");
    document.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
    if (resolveAuth) { resolveAuth(user); resolveAuth = null; }
  }
  function openAuth({ mode = "login", reason = "" } = {}) {
    if (!dlg) buildDialog();
    dlg.setMode(mode);
    dlg.querySelector("#auth-reason").textContent = reason;
    lastFocus = document.activeElement;
    dlg.classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(() => dlg.querySelector("input[name=email]").focus(), 30);
    return new Promise((r) => { resolveAuth = r; });
  }
  async function requireUser(reason) {
    const u = await me();
    return u || openAuth({ mode: "signup", reason });
  }

  // ---------- nav ----------
  function navLink() {
    const nav = document.getElementById("nav-links");
    if (!nav) return;
    let a = nav.querySelector("a.acct");
    if (!a) {
      a = document.createElement("a");
      a.className = "acct";
      a.href = "/account.html";
      const cta = nav.querySelector(".btn");
      nav.insertBefore(a, cta);
    }
    onUser((u) => {
      a.textContent = u ? "My account" : "Sign in";
      if (location.pathname.startsWith("/account")) a.setAttribute("aria-current", "page");
    });
  }

  window.TDCC = { api, esc, money, ago, toast, me, onUser, setUser, logout, openAuth, requireUser };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", navLink); else navLink();
})();
