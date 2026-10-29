// TDCC Chat on the main site: a paid chat app. Conversations live in this
// browser (localStorage, keys prefixed "tdcc.chat."); every message is sent to
// POST /api/chat, streamed back as server-sent events and billed from the
// signed-in account's prepaid balance (see docs/billing-api.md).
//
// Model output is never injected as HTML: renderMarkdown() escapes everything
// and only emits a fixed set of tags it builds itself.
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const T = window.TDCC || null;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MAX_HISTORY = 40; // messages sent per request
  const MAX_CHARS = 32000; // characters per message
  const MAX_CONVS = 200; // conversations kept in storage

  // ---------- storage (every access guarded: private mode, quota, disabled storage) ----------
  const PREFIX = "tdcc.chat.";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch { return false; } },
  };

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" /></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>',
  };

  // ---------- markdown: escape first, then build a fixed set of tags ----------
  const SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;
  function safeHref(raw) {
    const url = String(raw || "").trim();
    if (!SAFE_URL.test(url)) return null;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch { return null; }
  }
  const link = (href, inner) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

  // Inline syntax. Code spans and links are swapped for placeholders before the
  // rest of the text is escaped, so their contents are never re-parsed.
  function inline(src, noLinks = false) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = String(src).replace(/\u0000/g, "");
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${esc(code.replace(/^ (.*) $/, "$1"))}</code>`));
    if (!noLinks) {
      s = s.replace(/\[([^\]\n]{1,500})\]\(\s*<?([^\s()<>]+(?:\([^\s()<>]*\))?[^\s()<>]*)>?(?:\s+"[^"\n]*")?\s*\)/g, (m, text, url) => {
        const href = safeHref(url);
        return href ? hold(link(href, inline(text, true))) : hold(esc(text));
      });
      s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (m, url) => { const href = safeHref(url); return href ? hold(link(href, esc(url))) : m; });
      s = s.replace(/\bhttps?:\/\/[^\s<>"'`\u0000]+/g, (m) => {
        const tail = m.match(/[).,;:!?'\]*_~]+$/);
        let url = m, rest = "";
        if (tail) { url = m.slice(0, -tail[0].length); rest = tail[0]; }
        // keep a closing paren that balances one inside the URL
        if (rest.startsWith(")") && (url.match(/\(/g) || []).length > (url.match(/\)/g) || []).length) { url += ")"; rest = rest.slice(1); }
        const href = safeHref(url);
        return href ? hold(link(href, esc(url))) + rest : m;
      });
    }
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] || "");
  }

  const RE = {
    fence: /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/,
    heading: /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/,
    hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^ {0,3}>\s?/,
    item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };
  const splitRow = (line) => {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    const cells = []; let cur = "", code = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
      if (ch === "`") code = !code;
      if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  const isBlockStart = (line, next) => RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.item.test(line) || (line.includes("|") && next !== undefined && RE.tableSep.test(next) && next.includes("-"));

  function codeBlock(lang, code) {
    const l = (lang || "").replace(/[^\w+#.-]/g, "").slice(0, 24);
    return `<div class="code-wrap"><div class="code-head"><span>${esc(l || "code")}</span><button type="button" class="code-copy" data-copy-code aria-label="Copy code">${ICON.copy}<span>Copy</span></button></div><pre><code${l ? ` data-lang="${esc(l)}"` : ""}>${esc(code)}</code></pre></div>`;
  }

  function renderList(lines) {
    // lines: [{indent, ordered, start, text}] already grouped; builds nested lists by indentation
    let html = "";
    const stack = [];
    const open = (it) => { stack.push(it); html += it.ordered ? `<ol${it.start !== 1 ? ` start="${it.start}"` : ""}>` : "<ul>"; };
    const close = () => { const it = stack.pop(); html += "</li>" + (it.ordered ? "</ol>" : "</ul>"); };
    for (const it of lines) {
      if (!stack.length) open(it);
      else {
        const top = stack[stack.length - 1];
        if (it.indent > top.indent) open(it);
        else {
          while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) close();
          const cur = stack[stack.length - 1];
          if (cur.ordered !== it.ordered) { close(); open(it); } // list type changed
          else html += "</li>";
        }
      }
      html += "<li>" + it.body.map((t) => inline(t)).join("<br>");
    }
    while (stack.length) close();
    return html;
  }

  function renderMarkdown(src, depth = 0) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n");
    let out = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = line.match(RE.fence);
      if (fence) {
        const mark = fence[1];
        const indent = line.match(/^ */)[0].length;
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i])) {
          body.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), "") : lines[i]);
          i++;
        }
        i++; // closing fence (or end of a still-streaming block)
        out += codeBlock(fence[2], body.join("\n"));
        continue;
      }

      const h = line.match(RE.heading);
      if (h) { const n = h[1].length; out += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }

      if (RE.hr.test(line)) { out += "<hr>"; i++; continue; }

      if (RE.quote.test(line)) {
        const body = [];
        while (i < lines.length && lines[i].trim() && (RE.quote.test(lines[i]) || !isBlockStart(lines[i], lines[i + 1]))) {
          body.push(lines[i].replace(RE.quote, ""));
          i++;
        }
        out += `<blockquote>${depth < 4 ? renderMarkdown(body.join("\n"), depth + 1) : `<p>${inline(body.join("\n")).replace(/\n/g, "<br>")}</p>`}</blockquote>`;
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""));
        const cols = head.length;
        const at = (k) => (align[k] ? ` style="text-align:${align[k]}"` : "");
        let t = "<thead><tr>" + head.map((c, k) => `<th${at(k)}>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const cells = splitRow(lines[i]);
          t += "<tr>" + Array.from({ length: cols }, (_, k) => `<td${at(k)}>${inline(cells[k] || "")}</td>`).join("") + "</tr>";
          i++;
        }
        out += `<div class="md-table"><table>${t}</tbody></table></div>`;
        continue;
      }

      if (RE.item.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const m = l.match(RE.item);
          if (m && !RE.hr.test(l)) {
            const ordered = /\d/.test(m[2]);
            items.push({ indent: Math.floor(m[1].replace(/\t/g, "    ").length / 2), ordered, start: ordered ? parseInt(m[2], 10) : 1, body: [m[3]] });
            i++;
          } else if (l.trim() && items.length && /^\s+/.test(l) && !RE.fence.test(l)) {
            items[items.length - 1].body.push(l.trim()); // continuation line
            i++;
          } else if (!l.trim()) {
            // a blank line ends the list unless another item follows
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && RE.item.test(lines[j])) { i = j; continue; }
            break;
          } else break;
        }
        out += renderList(items);
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
      out += `<p>${para.map((p) => inline(p.trim())).join("<br>")}</p>`;
    }
    return out;
  }

  // ---------- money ----------
  function usd(v, { cost = false } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    if (n === 0) return "$0.00";
    const a = Math.abs(n);
    if (cost && a < 0.01) return (n < 0 ? "-$" : "$") + a.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return (n < 0 ? "-$" : "$") + a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: cost ? 4 : 2 });
  }
  const perM = (v) => { const n = Number(v); return Number.isFinite(n) ? "$" + (n < 1 ? n.toFixed(2) : n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })) : "—"; };

  // ---------- state ----------
  const loadConvs = () => {
    const raw = store.get("convs", []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)).map((c) => ({
      id: c.id,
      title: String(c.title || "New chat").slice(0, 120),
      created: Number(c.created) || Number(c.updated) || Date.now(),
      updated: Number(c.updated) || Date.now(),
      messages: c.messages.filter((m) => m && (m.role === "user" || m.role === "assistant")).map((m) => ({ ...m, content: String(m.content || "") })),
    }));
  };
  let convs = loadConvs();
  let activeId = store.get("active", null);
  if (!convs.some((c) => c.id === activeId)) activeId = null;
  const savedSettings = store.get("settings", {}) || {};
  const settings = {
    temperature: Number.isFinite(Number(savedSettings.temperature)) ? Math.min(2, Math.max(0, Number(savedSettings.temperature))) : 0.7,
    system: typeof savedSettings.system === "string" ? savedSettings.system.slice(0, 4000) : "",
  };
  let user; // undefined while loading, null when signed out
  const billing = { state: "idle", balance: null, pricing: null };
  let controller = null;
  let streaming = null; // { conv, msg }

  const active = () => convs.find((c) => c.id === activeId) || null;

  function saveConvs() {
    convs.sort((a, b) => b.updated - a.updated);
    if (convs.length > MAX_CONVS) convs.length = MAX_CONVS;
    // Strip the in-flight flag; if storage is full, drop the oldest chats until it fits.
    const data = () => convs.map((c) => ({ ...c, messages: c.messages.map(({ pending, ...m }) => m) }));
    while (!store.set("convs", data()) && convs.length > 1) {
      const victim = convs.slice().reverse().find((c) => c.id !== activeId);
      if (!victim) break;
      convs = convs.filter((c) => c !== victim);
    }
    store.set("active", activeId);
  }
  const saveSettings = () => store.set("settings", settings);

  // ---------- elements ----------
  const app = $("#chat-app");
  if (!app) return;
  const el = {
    list: $("#conv-list"), search: $("#conv-search"), newChat: $("#new-chat"),
    side: $("#chat-side"), sideOpen: $("#side-open"), sideClose: $("#side-close"), scrim: $("#chat-scrim"),
    scroll: $("#chat-scroll"), empty: $("#chat-empty"), thread: $("#thread"), suggest: $("#suggest"),
    composer: $("#composer"), input: $("#composer-input"), send: $("#send-btn"),
    gate: $("#gate"), gateSignup: $("#gate-signup"), gateLogin: $("#gate-login"),
    price: $("#model-price"), pill: $("#model-pill"),
    chip: $("#bal-chip"), chipN: $("#bal-chip-n"), headSignin: $("#head-signin"),
    balSide: $("#bal-side"), balSub: $("#bal-sub"),
    settingsBtn: $("#settings-btn"), settingsPop: $("#settings-pop"), temp: $("#temp"), tempOut: $("#temp-out"), system: $("#system-prompt"),
  };

  const toast = (msg, bad) => { if (T) T.toast(msg, bad); };

  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove();
      } catch { ok = false; }
    }
    toast(ok ? "Copied" : "Could not copy", !ok);
    if (ok && btn) {
      const svg = btn.querySelector("svg");
      if (svg) { const old = svg.outerHTML; svg.outerHTML = ICON.check; setTimeout(() => { const s = btn.querySelector("svg"); if (s) s.outerHTML = old; }, 1200); }
    }
  }

  // ---------- sign-in ----------
  function signIn(mode = "signup", reason = "") {
    if (!T) { location.href = "/account.html"; return Promise.resolve(null); }
    return T.openAuth({ mode, reason: reason || (mode === "signup" ? "Create a free account to use TDCC Chat. You only pay for the messages you send." : "Sign in to use TDCC Chat.") });
  }

  // ---------- billing ----------
  async function loadBilling() {
    if (!T || !user) return;
    if (billing.state !== "ok") billing.state = "loading";
    renderBalance();
    try {
      const d = await T.api("GET", "/api/billing");
      billing.state = "ok";
      billing.balance = d && d.balance ? d.balance.usd : null;
      billing.pricing = Array.isArray(d && d.pricing) ? d.pricing : null;
    } catch (err) {
      if (err && err.status === 401) { T.setUser(null); return; }
      billing.state = "error";
    }
    renderBalance();
  }

  function renderBalance() {
    const signedIn = !!user;
    el.chip.hidden = !signedIn;
    el.headSignin.hidden = signedIn || user === undefined;
    const model = (billing.pricing || []).find((p) => p && p.id === "tdcc-chat") || (billing.pricing || [])[0];
    if (model) {
      el.pill.textContent = model.name || "TDCC Chat";
      const ctx = Number(model.context_length);
      el.pill.title = ctx ? `${model.id} · ${Math.round(ctx / 1000)}K context` : model.id || "";
      el.price.textContent = `${perM(model.input_per_m_usd)} in · ${perM(model.output_per_m_usd)} out per 1M tokens`;
    } else {
      el.price.textContent = "Pay per message";
    }
    let n = "—", sub = "Each message is billed from your prepaid balance.";
    if (!signedIn) { n = "—"; sub = user === undefined ? "Checking your account…" : "Sign in to see your balance and start chatting."; }
    else if (billing.state === "loading" && billing.balance == null) { n = "…"; }
    else if (billing.state === "error" && billing.balance == null) { n = "—"; sub = "Balance is unavailable right now."; }
    else if (billing.balance != null) {
      n = usd(billing.balance);
      if (Number(billing.balance) <= 0) sub = "Top up with USDC to send messages.";
    }
    const low = signedIn && billing.balance != null && Number(billing.balance) < 0.05;
    el.balSide.textContent = n;
    el.balSub.textContent = sub;
    el.chipN.textContent = n;
    el.chip.classList.toggle("low", low);
    el.chip.setAttribute("aria-label", n === "—" || n === "…" ? "Balance unavailable. Top up" : `Balance ${n}. Top up`);
  }

  function renderAuth() {
    const out = user === null;
    el.composer.hidden = out;
    el.gate.hidden = !out;
    renderBalance();
    updateSend();
  }

  // ---------- conversation list ----------
  function groupOf(ts) {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86400000);
    return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : "Earlier";
  }

  function renderList() {
    const q = el.search.value.trim().toLowerCase();
    const list = convs
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
      .sort((a, b) => b.updated - a.updated);
    if (!list.length) {
      el.list.innerHTML = `<p class="conv-empty">${q ? "No chats match your search." : "No chats yet. Your conversations are saved in this browser."}</p>`;
      return;
    }
    const groups = new Map();
    for (const c of list) {
      const g = groupOf(c.updated);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    let html = "";
    let gi = 0;
    for (const [g, items] of groups) {
      const id = `conv-g-${gi++}`;
      html += `<h3 class="conv-group" id="${id}">${g}</h3><ul aria-labelledby="${id}">`;
      for (const c of items) {
        const on = c.id === activeId;
        html += `<li class="conv-item${on ? " on" : ""}"><button type="button" class="conv-open" data-id="${esc(c.id)}"${on ? ' aria-current="true"' : ""} title="${esc(c.title)}">${esc(c.title)}</button>`
          + `<button type="button" class="conv-del" data-del="${esc(c.id)}" aria-label="Delete chat: ${esc(c.title)}">${ICON.trash}</button></li>`;
      }
      html += "</ul>";
    }
    el.list.innerHTML = html;
  }

  // ---------- thread ----------
  const NOTICE = {
    auth: () => ({ bad: false, html: "<b>You're signed out.</b><span>Sign in to your TDCC account to send this message.</span>", actions: '<button class="btn solid sm" type="button" data-act="signin">Sign in</button><button class="btn sm" type="button" data-act="retry">Retry</button>' }),
    balance: (m) => ({ bad: false, html: `<b>Your balance is too low for this message.</b><span>${esc(m.error || "Add funds to keep chatting.")} Top up with USDC and your balance updates once the payment is confirmed on chain.</span>`, actions: '<a class="btn solid sm" href="/account.html#billing">Top up with USDC</a><button class="btn sm" type="button" data-act="retry">Retry</button>' }),
    rate: (m) => ({ bad: false, html: `<b>Slow down a little.</b><span>${esc(m.error || "Too many messages in a short time.")} Wait a moment, then retry.</span>`, actions: '<button class="btn sm" type="button" data-act="retry">Retry</button>' }),
    error: (m) => ({ bad: true, html: `<b>Something went wrong.</b><span>${esc(m.error || "The reply could not be completed.")}</span>`, actions: '<button class="btn sm" type="button" data-act="retry">Retry</button>' }),
  };

  function botInner(m) {
    let html = "";
    if (m.reasoning) {
      const thinking = m.pending && !m.content;
      html += `<details class="reasoning"${thinking ? " open" : ""}><summary>${thinking ? "Thinking…" : "Reasoning"}</summary><div class="r-body">${esc(m.reasoning)}</div></details>`;
    }
    if (m.content) html += `<div class="md${m.pending ? " streaming-cursor" : ""}">${renderMarkdown(m.content)}</div>`;
    else if (m.pending && !m.reasoning) html += '<div class="typing" aria-label="TDCC Chat is typing"><i></i><i></i><i></i></div>';
    if (m.notice) {
      const n = (NOTICE[m.notice] || NOTICE.error)(m);
      html += `<div class="notice${n.bad ? " bad" : ""}" role="alert"><div>${n.html}</div><div class="actions">${n.actions}</div></div>`;
    }
    if (!m.pending) {
      const meta = [];
      if (m.content) meta.push(`<div class="msg-acts"><button type="button" class="msg-act" data-act="copy" aria-label="Copy reply">${ICON.copy}</button><button type="button" class="msg-act" data-act="regen" aria-label="Regenerate reply"${controller ? " disabled" : ""}>${ICON.redo}</button></div>`);
      if (m.stopped) meta.push(`<span class="stopped">${m.content ? "Stopped" : "Stopped before a reply"}</span>`);
      if (m.cost != null) meta.push(`<span class="msg-cost">Cost <b>${esc(usd(m.cost, { cost: true }))}</b>${m.balance != null ? ` · balance ${esc(usd(m.balance))}` : ""}</span>`);
      if (meta.length) html += `<div class="msg-meta">${meta.join("")}</div>`;
    }
    return html;
  }

  function msgHtml(m, i) {
    if (m.role === "user") return `<div class="msg user" data-i="${i}"><span class="sr-only">You said:</span><div class="bubble">${esc(m.content)}</div></div>`;
    return `<article class="msg bot" data-i="${i}"><span class="bot-av" aria-hidden="true"><svg><use href="#mark" /></svg></span><div class="bot-body"><span class="sr-only">TDCC Chat:</span>${botInner(m)}</div></article>`;
  }

  function renderThread() {
    const c = active();
    const has = !!(c && c.messages.length);
    el.empty.hidden = has;
    el.thread.innerHTML = has ? c.messages.map(msgHtml).join("") : "";
    scrollBottom(true);
  }

  function paintMessage(i) {
    const c = active();
    if (!c || !c.messages[i]) return;
    const node = el.thread.querySelector(`.msg[data-i="${i}"] .bot-body`);
    if (!node) { renderThread(); return; }
    node.innerHTML = '<span class="sr-only">TDCC Chat:</span>' + botInner(c.messages[i]);
    scrollBottom();
  }

  let stick = true;
  el.scroll.addEventListener("scroll", () => { stick = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 80; }, { passive: true });
  function scrollBottom(force) {
    if (force) stick = true;
    if (stick) el.scroll.scrollTop = el.scroll.scrollHeight;
  }

  // ---------- composer ----------
  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
    updateSend();
  }
  function updateSend() {
    const busy = !!controller;
    el.composer.classList.toggle("streaming", busy);
    el.send.disabled = !busy && !el.input.value.trim();
    el.send.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
    el.thread.setAttribute("aria-busy", String(busy));
  }

  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!controller) submit();
    }
  });
  el.composer.addEventListener("submit", (e) => { e.preventDefault(); if (controller) stop(); else submit(); });

  function submit() {
    const text = el.input.value.trim();
    if (!text || controller) return;
    send(text);
  }

  async function send(text) {
    if (user === undefined && T) { user = await T.me(); renderAuth(); }
    if (!user) {
      const u = await signIn("signup", "Create a free account to send this message. You only pay for what you use.");
      if (!u) return;
    }
    let c = active();
    if (!c) {
      const now = Date.now();
      c = { id: uid(), title: text.replace(/\s+/g, " ").slice(0, 60), created: now, updated: now, messages: [] };
      convs.unshift(c);
      activeId = c.id;
    }
    // Drop failed attempts at the end of the chat before adding the new message.
    while (c.messages.length && c.messages[c.messages.length - 1].role === "assistant" && c.messages[c.messages.length - 1].notice && !c.messages[c.messages.length - 1].content) c.messages.pop();
    c.messages.push({ role: "user", content: text.slice(0, MAX_CHARS), at: Date.now() });
    c.updated = Date.now();
    el.input.value = "";
    autosize();
    saveConvs(); renderList(); renderThread();
    generate(c);
  }

  function buildHistory(messages) {
    const h = messages
      .filter((m) => !m.notice || m.content)
      .filter((m) => m.content && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.length > MAX_CHARS ? m.content.slice(0, MAX_CHARS) : m.content }))
      .slice(-MAX_HISTORY);
    const sys = settings.system.trim();
    if (sys) h.unshift({ role: "system", content: sys.slice(0, MAX_CHARS) });
    return h;
  }

  function stop() { if (controller) controller.abort(); }

  async function generate(c) {
    if (controller) return;
    const msg = { role: "assistant", content: "", reasoning: "", pending: true, at: Date.now() };
    c.messages.push(msg);
    const idx = c.messages.length - 1;
    const history = buildHistory(c.messages.slice(0, idx));
    controller = new AbortController();
    streaming = { conv: c, msg };
    updateSend();
    if (c.id === activeId) { el.empty.hidden = true; el.thread.insertAdjacentHTML("beforeend", msgHtml(msg, idx)); scrollBottom(true); }

    let raf = 0;
    const paint = () => { raf = 0; if (c.id === activeId) paintMessage(idx); };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
    let billed = false;

    const handle = (data) => {
      if (data === "[DONE]") return;
      let j;
      try { j = JSON.parse(data); } catch { return; }
      if (!j || typeof j !== "object") return;
      if (j.object === "tdcc.billing") {
        billed = true;
        msg.cost = j.cost_usd;
        if (j.balance_usd != null) { msg.balance = j.balance_usd; billing.balance = j.balance_usd; billing.state = "ok"; renderBalance(); }
        return;
      }
      if (j.error) { msg.notice = "error"; msg.error = typeof j.error === "string" ? j.error : j.error.message || "The reply was interrupted."; return; }
      const d = (j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message)) || {};
      if (typeof d.reasoning_content === "string") msg.reasoning += d.reasoning_content;
      if (typeof d.content === "string") msg.content += d.content;
      schedule();
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ messages: history, temperature: settings.temperature }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch { /* not JSON */ }
        const text = typeof data.error === "string" ? data.error : data.error && data.error.message;
        msg.error = text || "";
        if (res.status === 401) {
          msg.notice = "auth";
          if (T) { T.setUser(null); signIn("login", "Your session has ended. Sign in to keep chatting."); }
        } else if (res.status === 402) {
          msg.notice = "balance";
          loadBilling();
        } else if (res.status === 429) {
          msg.notice = "rate";
        } else {
          msg.notice = "error";
          if (!text) msg.error = res.status === 404 ? "TDCC Chat is not available on this deployment yet." : `The request failed (${res.status}).`;
        }
        billed = true; // nothing was charged
      } else if (!res.body || /application\/json/i.test(res.headers.get("content-type") || "")) {
        // Non-streamed answer: treat the whole body as one chunk.
        handle(await res.text());
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const lines = (final) => {
          let k;
          while ((k = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, k).replace(/\r$/, ""); buf = buf.slice(k + 1);
            if (line.startsWith("data:")) handle(line.slice(5).trim());
          }
          if (final && buf.startsWith("data:")) { handle(buf.slice(5).trim()); buf = ""; }
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { buf += dec.decode(); lines(true); break; }
          buf += dec.decode(value, { stream: true });
          lines(false);
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") msg.stopped = true;
      else { msg.notice = "error"; msg.error = "Could not reach TDCC Chat. Check your connection and try again."; }
    } finally {
      if (raf) cancelAnimationFrame(raf);
      delete msg.pending;
      if (!msg.reasoning) delete msg.reasoning;
      if (!msg.content && !msg.notice && !msg.stopped) { msg.notice = "error"; msg.error = "The reply came back empty."; }
      controller = null;
      streaming = null;
      c.updated = Date.now();
      saveConvs(); renderList();
      if (c.id === activeId) renderThread();
      updateSend();
      // The server charges for stopped or cut-off replies too; refresh the balance if no billing event arrived.
      if (!billed) loadBilling();
    }
  }

  // ---------- thread actions ----------
  el.thread.addEventListener("click", (e) => {
    const cc = e.target.closest("[data-copy-code]");
    if (cc) { const code = cc.closest(".code-wrap").querySelector("code"); copyText(code ? code.textContent : "", cc); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const row = b.closest(".msg");
    const c = active();
    if (!row || !c) return;
    const i = Number(row.dataset.i);
    const m = c.messages[i];
    if (!m) return;
    const act = b.dataset.act;
    if (act === "copy") copyText(m.content, b);
    else if (act === "signin") signIn("login").then((u) => { if (u) regenerate(c, i); });
    else if ((act === "regen" || act === "retry") && !controller) regenerate(c, i);
  });

  async function regenerate(c, i) {
    if (controller) return;
    if (!user) { const u = await signIn("login"); if (!u) return; }
    c.messages = c.messages.slice(0, i);
    if (!c.messages.length || c.messages[c.messages.length - 1].role !== "user") { saveConvs(); renderThread(); return; }
    saveConvs(); renderThread();
    generate(c);
  }

  // ---------- conversations ----------
  function openConv(id) {
    if (controller) stop();
    activeId = id;
    store.set("active", activeId);
    renderList(); renderThread(); closeDrawer(false);
    if (!el.composer.hidden) el.input.focus();
  }
  function newChat() {
    if (controller) stop();
    activeId = null;
    store.set("active", null);
    renderList(); renderThread(); closeDrawer(false);
    if (!el.composer.hidden) el.input.focus();
  }

  el.list.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const id = del.dataset.del;
      const c = convs.find((x) => x.id === id);
      if (!c) return;
      if (streaming && streaming.conv === c) stop();
      convs = convs.filter((x) => x !== c);
      if (activeId === id) activeId = null;
      saveConvs(); renderList(); renderThread();
      toast("Chat deleted");
      el.search.focus();
      return;
    }
    const open = e.target.closest("[data-id]");
    if (open) openConv(open.dataset.id);
  });
  el.search.addEventListener("input", renderList);
  el.newChat.addEventListener("click", newChat);
  el.suggest.addEventListener("click", (e) => {
    const b = e.target.closest("[data-prompt]");
    if (!b || controller) return;
    if (user === null) { signIn("signup").then((u) => { if (u) send(b.dataset.prompt); }); return; }
    send(b.dataset.prompt);
  });
  el.gateSignup.addEventListener("click", () => signIn("signup"));
  el.gateLogin.addEventListener("click", () => signIn("login"));
  el.headSignin.addEventListener("click", () => signIn("login"));

  // ---------- drawer (mobile) ----------
  const mobile = () => window.matchMedia("(max-width: 860px)").matches;
  function openDrawer() {
    app.classList.add("drawer-open");
    el.sideOpen.setAttribute("aria-expanded", "true");
    setTimeout(() => el.newChat.focus(), reduceMotion() ? 0 : 60);
  }
  function closeDrawer(focusBack = true) {
    if (!app.classList.contains("drawer-open")) return;
    app.classList.remove("drawer-open");
    el.sideOpen.setAttribute("aria-expanded", "false");
    if (focusBack) el.sideOpen.focus();
  }
  el.sideOpen.addEventListener("click", openDrawer);
  el.sideClose.addEventListener("click", () => closeDrawer());
  el.scrim.addEventListener("click", () => closeDrawer());
  window.addEventListener("resize", () => { if (!mobile()) closeDrawer(false); });

  // ---------- settings ----------
  el.temp.value = String(settings.temperature);
  el.tempOut.textContent = settings.temperature.toFixed(1);
  el.system.value = settings.system;
  const setPop = (open) => {
    el.settingsPop.hidden = !open;
    el.settingsBtn.setAttribute("aria-expanded", String(open));
    if (open) el.temp.focus();
  };
  el.settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); setPop(el.settingsPop.hidden); });
  el.settingsPop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { if (!el.settingsPop.hidden) setPop(false); });
  el.temp.addEventListener("input", () => {
    settings.temperature = Math.min(2, Math.max(0, Number(el.temp.value) || 0));
    el.tempOut.textContent = settings.temperature.toFixed(1);
    saveSettings();
  });
  el.system.addEventListener("input", () => { settings.system = el.system.value.slice(0, 4000); saveSettings(); });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (document.querySelector(".modal.open")) return; // the sign-in dialog handles its own Escape
      if (!el.settingsPop.hidden) { setPop(false); el.settingsBtn.focus(); return; }
      if (app.classList.contains("drawer-open")) { closeDrawer(); return; }
      if (controller && document.activeElement === el.input) stop();
    }
  });

  // Keep the composer usable while the soft keyboard resizes the viewport.
  window.addEventListener("resize", () => scrollBottom());

  // ---------- boot ----------
  renderList();
  renderThread();
  renderAuth();
  autosize();
  if (T) {
    T.onUser((u) => {
      const was = user;
      user = u || null;
      if (!user) { billing.state = "idle"; billing.balance = null; }
      renderAuth();
      if (user && (!was || was.id !== user.id || billing.state !== "ok")) loadBilling();
    });
  } else {
    user = null;
    renderAuth();
  }
})();
