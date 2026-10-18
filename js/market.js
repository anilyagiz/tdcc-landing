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
  let cfg = { email_enabled: false, turnstile_site_key: null, payments: false };
  const listeners = new Set();
  function me(refresh = false) {
    if (!mePromise || refresh) mePromise = api("GET", "/api/me").then((d) => { cfg = d; return d.user; }).catch(() => null);
    return mePromise;
  }
  // Site settings from /api/me: whether email, card payments, and the robot check are on.
  const config = () => me().then(() => cfg);

  // Cloudflare Turnstile, loaded only when the deployment turns it on.
  let turnstileLoad = null;
  function turnstile(container) {
    return config().then((c) => {
      if (!c.turnstile_site_key) return null;
      if (!turnstileLoad) {
        turnstileLoad = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
          s.async = true; s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      return turnstileLoad.then(() => {
        container.innerHTML = "";
        const id = window.turnstile.render(container, { sitekey: c.turnstile_site_key, theme: "dark" });
        return { token: () => window.turnstile.getResponse(id) || "", reset: () => window.turnstile.reset(id) };
      });
    }).catch(() => null);
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
          <label class="fl" data-hide="forgot">Password<input class="inp" name="password" type="password" autocomplete="current-password" minlength="10" maxlength="200" />
            <small data-only="signup" hidden>At least 10 characters. A short sentence works well.</small></label>
          <label class="fl" data-only="2fa" hidden>Code from your authenticator app<input class="inp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="123456" />
            <small>Lost your phone? Enter one of your recovery codes instead.</small></label>
          <div id="auth-human" data-only-human></div>
          <label class="check" data-only="signup" hidden><input type="checkbox" name="accept_terms" /> <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">privacy policy</a>.</span></label>
          <button class="btn solid" type="submit" id="auth-submit">Sign in →</button>
          <button class="link" type="button" data-only="login" id="auth-forgot" style="background:none;border:0;padding:0;cursor:pointer;justify-self:start">Forgot your password?</button>
          <button class="link" type="button" data-only="forgot" hidden id="auth-back" style="background:none;border:0;padding:0;cursor:pointer;justify-self:start">← Back to sign in</button>
        </form>
      </div>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("#auth-form");
    let mode = "login", human = null, challenge = null;
    const setMode = (m) => {
      mode = m;
      dlg.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === m)));
      dlg.querySelectorAll("[data-only]").forEach((el) => { el.hidden = el.dataset.only !== m; });
      dlg.querySelectorAll("[data-hide]").forEach((el) => { el.hidden = el.dataset.hide === m || m === "2fa"; });
      dlg.querySelector("input[name=email]").closest("label").hidden = m === "2fa";
      dlg.querySelector(".tabs").hidden = m === "forgot" || m === "2fa";
      dlg.querySelector("#auth-title").textContent = { signup: "Create your account", login: "Sign in", forgot: "Reset your password", "2fa": "Two-factor sign-in" }[m];
      dlg.querySelector("#auth-submit").textContent = { signup: "Create account →", login: "Sign in →", forgot: "Email me a reset link →", "2fa": "Verify →" }[m];
      if (m === "forgot") dlg.querySelector("#auth-reason").textContent = "Enter your account email and we will send you a link to choose a new password.";
      if (m === "2fa") dlg.querySelector("#auth-reason").textContent = "Enter the 6-digit code from your authenticator app.";
      const humanBox = dlg.querySelector("#auth-human");
      human = null;
      humanBox.innerHTML = "";
      if (m === "signup" || m === "forgot") turnstile(humanBox).then((h) => { human = h; });
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
    dlg.querySelector("#auth-forgot").addEventListener("click", () => setMode("forgot"));
    dlg.querySelector("#auth-back").addEventListener("click", () => setMode("login"));
    dlg.querySelectorAll("[data-auth-close]").forEach((b) => b.addEventListener("click", () => closeAuth(null)));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeAuth(null); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg.classList.contains("open")) closeAuth(null); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = dlg.querySelector("#auth-submit");
      if (mode === "forgot") {
        const addr = form.email.value.trim();
        if (!addr) return showErr("Enter your email address.", "email");
        btn.disabled = true;
        try {
          await api("POST", "/api/auth/forgot", { email: addr, turnstile: human ? human.token() : undefined });
          showErr("");
          dlg.querySelector("#auth-reason").textContent = `If ${addr} has an account, a reset link is on its way. Check your inbox (and spam folder) in a minute.`;
        } catch (err) {
          showErr(err.message, err.field);
          if (human) human.reset();
        } finally {
          btn.disabled = false;
        }
        return;
      }
      if (mode === "2fa") {
        const code = form.code.value.trim();
        if (!code) return showErr("Enter the code.", "code");
        btn.disabled = true;
        try {
          const d = await api("POST", "/api/auth/login/2fa", { challenge, code });
          form.reset();
          setUser(d.user);
          toast("Signed in");
          closeAuth(d.user);
        } catch (err) {
          if (err.status === 401 && err.field !== "code") setMode("login");
          showErr(err.message, err.field);
        } finally {
          btn.disabled = false;
        }
        return;
      }
      const body = { email: form.email.value.trim(), password: form.password.value };
      if (!body.email || !body.password) return showErr("Enter your email and password.", !body.email ? "email" : "password");
      if (mode === "signup") {
        body.name = form.name.value.trim();
        body.accept_terms = form.accept_terms.checked;
        if (!body.name) return showErr("Tell us your name.", "name");
        if (body.password.length < 10) return showErr("Use at least 10 characters for your password.", "password");
        if (!body.accept_terms) return showErr("Please accept the terms to continue.");
        if (human) body.turnstile = human.token();
      }
      btn.disabled = true;
      try {
        const d = await api("POST", mode === "signup" ? "/api/auth/signup" : "/api/auth/login", body);
        if (d.two_factor_required) {
          challenge = d.challenge;
          setMode("2fa");
          setTimeout(() => form.code.focus(), 30);
          return;
        }
        form.reset();
        setUser(d.user);
        toast(mode === "signup"
          ? (d.user.needs_verification ? `Welcome, ${d.user.name.split(" ")[0]}. Check your inbox to confirm your email.` : `Welcome, ${d.user.name.split(" ")[0]}`)
          : "Signed in");
        closeAuth(d.user);
      } catch (err) {
        showErr(err.message, err.field);
        if (human) human.reset();
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

  async function resendVerification() {
    try {
      await api("POST", "/api/me/verify-email", {});
      toast("Confirmation email sent. Check your inbox.");
    } catch (err) {
      toast(err.message, true);
    }
  }

    const stars = (rating, count) => (rating ? `★ ${Number(rating).toFixed(1)}${count !== undefined ? ` (${count})` : ""}` : "");

  window.TDCC = { api, esc, money, ago, toast, me, config, onUser, setUser, logout, openAuth, requireUser, resendVerification, turnstile, stars };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", navLink); else navLink();
})();
