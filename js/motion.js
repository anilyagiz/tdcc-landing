// Motion for the marketplace pages: a live GPU-network canvas, count-up
// numbers, a listings ticker, staggered reveals, cursor spotlights, a typing
// terminal, and scroll-drawn step lines. Everything is opt-in through data
// attributes, pauses when off screen, and stays still for people who ask
// their system for reduced motion.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  // Run `fn(entry)` when an element scrolls into view (once unless `keep`).
  function onView(el, fn, { keep = false, margin = "0px 0px -10% 0px" } = {}) {
    if (!("IntersectionObserver" in window)) { fn({ isIntersecting: true }); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (keep) fn(e);
        else if (e.isIntersecting) { fn(e); io.unobserve(e.target); }
      }
    }, { rootMargin: margin });
    io.observe(el);
  }

  // ---------- reveal ----------
  function reveal(root = document) {
    root.querySelectorAll(".reveal:not(.in)").forEach((el) => onView(el, () => el.classList.add("in")));
    root.querySelectorAll("[data-stagger]").forEach((group) => {
      if (group.dataset.staggered) return;
      group.dataset.staggered = "1";
      onView(group, () => stagger(group));
    });
  }
  function stagger(group, selector = group.dataset.stagger || ":scope > *") {
    const items = [...group.querySelectorAll(selector)];
    items.forEach((el, i) => {
      el.classList.add("st-item");
      el.style.setProperty("--st-delay", `${Math.min(i, 14) * 55}ms`);
      requestAnimationFrame(() => el.classList.add("st-in"));
    });
  }

  // ---------- count-up ----------
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function count(el, to, { duration = 1100, format = (n) => Math.round(n).toLocaleString("en-US") } = {}) {
    const from = Number(el.dataset.countNow || 0);
    el.dataset.countNow = String(to);
    if (reduce || from === to) { el.textContent = format(to); return; }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = format(from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- spotlight ----------
  // Children matching `data-spotlight` get --mx/--my where the cursor is.
  function spotlight(root) {
    const sel = root.dataset.spotlight || ".spot";
    root.addEventListener("pointermove", (e) => {
      const el = e.target.closest(sel);
      if (!el || !root.contains(el)) return;
      el.classList.add("spot");
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    }, { passive: true });
  }

  // ---------- ticker ----------
  // Fills a marquee with items and duplicates them for a seamless loop.
  function ticker(el, items) {
    const track = el.querySelector(".ticker-track") || el.appendChild(Object.assign(document.createElement("div"), { className: "ticker-track" }));
    if (!items.length) { el.hidden = true; return; }
    el.hidden = false;
    const html = items.map((i) => `<span class="ticker-item">${i}</span>`).join("");
    track.innerHTML = html + html.replace(/class="ticker-item"/g, 'class="ticker-item" aria-hidden="true"');
    const px = track.scrollWidth / 2;
    track.style.setProperty("--ticker-dur", `${Math.max(20, px / 45)}s`);
  }

  // ---------- typing terminal ----------
  // <pre data-typing> with lines in data-lines (JSON): [{t:"$ cmd", k:"cmd"}, {t:"output"}]
  function typing(el) {
    let lines;
    try { lines = JSON.parse(el.dataset.lines); } catch { return; }
    const render = (upto, partial) => {
      el.innerHTML = lines.slice(0, upto).map((l) => line(l)).join("") + (partial !== undefined ? line({ ...lines[upto], t: partial }, true) : "");
    };
    const line = (l, cursor = false) => `<span class="tl ${l.k || "out"}">${esc(l.t)}${cursor ? '<i class="caret"></i>' : ""}</span>`;
    if (reduce) { render(lines.length); return; }
    let visible = false, running = false;
    const run = async () => {
      if (running) return;
      running = true;
      while (visible) {
        for (let i = 0; i < lines.length && visible; i++) {
          const l = lines[i];
          if (l.k === "cmd") {
            const per = l.t.length > 60 ? 9 : 22;
            for (let c = 2; c <= l.t.length && visible; c++) { render(i, l.t.slice(0, c)); await wait(per + Math.random() * per); }
            await wait(320);
          } else {
            await wait(l.k === "ok" ? 520 : 140);
          }
          render(i + 1);
        }
        await wait(4200);
      }
      running = false;
    };
    onView(el, (e) => { visible = e.isIntersecting; if (visible) run(); }, { keep: true, margin: "0px" });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- step line ----------
  // A vertical line that fills as the list scrolls through the viewport.
  function drawLine(list) {
    if (reduce) { list.style.setProperty("--draw", "1"); return; }
    let active = false;
    const update = () => {
      if (!active) return;
      const r = list.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.min(1, Math.max(0, (vh * 0.75 - r.top) / r.height));
      list.style.setProperty("--draw", p.toFixed(3));
    };
    onView(list, (e) => { active = e.isIntersecting; update(); }, { keep: true, margin: "0px" });
    window.addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
  }

  // ---------- GPU network canvas ----------
  // Nodes on a jittered grid (GPUs), links to near neighbours, and packets
  // of work hopping across the mesh. Nodes that receive work flash; some
  // nodes are "online" and breathe. The cursor brightens nearby nodes.
  function network(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sand = css("--sand", "#d8bf94"), ok = css("--ok", "#b9d99a");
    let w = 0, h = 0, dpr = 1, nodes = [], links = [], packets = [], mouse = null, running = false, last = 0;
    const rand = (a, b) => a + Math.random() * (b - a);

    function build() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, r.width); h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gap = w < 700 ? 54 : 64;
      nodes = [];
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          if (Math.random() < 0.38) continue;
          nodes.push({ x: x + rand(-gap * 0.28, gap * 0.28), y: y + rand(-gap * 0.28, gap * 0.28), online: Math.random() < 0.22, phase: rand(0, Math.PI * 2), flash: 0, size: Math.random() < 0.12 ? 3.2 : 2 });
        }
      }
      links = [];
      nodes.forEach((a, i) => {
        const near = nodes.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) })).filter((n) => n.j !== i && n.d < gap * 1.55).sort((p, q) => p.d - q.d).slice(0, 3);
        near.forEach((n) => { if (i < n.j) links.push([i, n.j]); });
      });
      packets = [];
    }

    function spawn() {
      if (!links.length) return;
      const [a, b] = links[Math.floor(Math.random() * links.length)];
      const forward = Math.random() < 0.5;
      packets.push({ from: forward ? a : b, to: forward ? b : a, t: 0, speed: rand(0.008, 0.02), hops: Math.floor(rand(2, 6)) });
    }

    function hop(p) {
      // Carry on to a random neighbour of the node we arrived at.
      const next = links.filter(([a, b]) => (a === p.to && b !== p.from) || (b === p.to && a !== p.from));
      if (!next.length || --p.hops <= 0) return false;
      const [a, b] = next[Math.floor(Math.random() * next.length)];
      p.from = p.to; p.to = a === p.to ? b : a; p.t = 0;
      return true;
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(48, now - (last || now)); last = now;
      ctx.clearRect(0, 0, w, h);
      // links
      ctx.lineWidth = 1;
      for (const [a, b] of links) {
        const A = nodes[a], B = nodes[b];
        ctx.strokeStyle = "rgba(216,191,148,0.07)";
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
      // packets with a short trail
      if (Math.random() < 0.09 && packets.length < 40) spawn();
      packets = packets.filter((p) => {
        p.t += p.speed * (dt / 16);
        const A = nodes[p.from], B = nodes[p.to];
        if (p.t >= 1) { B.flash = 1; return hop(p); }
        const x = A.x + (B.x - A.x) * p.t, y = A.y + (B.y - A.y) * p.t;
        const tx = A.x + (B.x - A.x) * Math.max(0, p.t - 0.35), ty = A.y + (B.y - A.y) * Math.max(0, p.t - 0.35);
        const g = ctx.createLinearGradient(tx, ty, x, y);
        g.addColorStop(0, "rgba(216,191,148,0)"); g.addColorStop(1, "rgba(245,238,228,0.75)");
        ctx.strokeStyle = g; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = "#f5eee4"; ctx.fillRect(x - 1, y - 1, 2, 2);
        return true;
      });
      // nodes
      for (const n of nodes) {
        n.flash = Math.max(0, n.flash - dt / 700);
        let glow = n.online ? 0.45 + 0.35 * Math.sin(now / 900 + n.phase) : 0.22;
        if (mouse) { const d = Math.hypot(n.x - mouse.x, n.y - mouse.y); if (d < 140) glow += (1 - d / 140) * 0.6; }
        glow = Math.min(1, glow + n.flash * 0.8);
        const s = n.size + n.flash * 1.5;
        if (n.online || n.flash > 0.05) {
          ctx.fillStyle = n.online ? hexA(ok, 0.12 * glow) : hexA(sand, 0.18 * n.flash);
          ctx.beginPath(); ctx.arc(n.x, n.y, 9 + n.flash * 8, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = hexA(n.online ? ok : sand, 0.25 + glow * 0.75);
        ctx.fillRect(n.x - s / 2, n.y - s / 2, s, s);
      }
      requestAnimationFrame(frame);
    }

    function still() {
      // One calm frame for reduced motion.
      ctx.clearRect(0, 0, w, h);
      for (const [a, b] of links) { const A = nodes[a], B = nodes[b]; ctx.strokeStyle = "rgba(216,191,148,0.07)"; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); }
      for (const n of nodes) { ctx.fillStyle = hexA(n.online ? ok : sand, n.online ? 0.8 : 0.35); ctx.fillRect(n.x - n.size / 2, n.y - n.size / 2, n.size, n.size); }
    }

    build();
    if (reduce) { still(); window.addEventListener("resize", () => { build(); still(); }); return; }
    const host = canvas.parentElement;
    host.addEventListener("pointermove", (e) => { const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; }, { passive: true });
    host.addEventListener("pointerleave", () => { mouse = null; });
    let resizeT;
    window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(build, 150); });
    const start = () => { if (!running && !document.hidden) { running = true; last = 0; requestAnimationFrame(frame); } };
    const stop = () => { running = false; };
    onView(canvas, (e) => (e.isIntersecting ? start() : stop()), { keep: true, margin: "0px" });
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  }

  // ---------- animated graphics card ----------
  // Fans spin with a simulated load, memory lights flicker with it, the
  // card tilts toward the cursor and bobs gently, and the floating chips
  // show the numbers. Purely illustrative.
  function gpu(root) {
    const card = root.querySelector(".gpu-card");
    const fans = [...root.querySelectorAll(".gpu-fan")].map((g) => ({ g, a: Math.random() * 360 }));
    const leds = [...root.querySelectorAll(".gpu-leds rect")];
    const out = (sel) => root.querySelector(sel);
    let load = 0.72, target = 0.72, running = false, last = 0, tx = 0, ty = 0;
    const show = () => {
      root.style.setProperty("--load", load.toFixed(3));
      const set = (sel, v) => { const el = out(sel); if (el) el.textContent = v; };
      set("[data-gpu-util]", Math.round(load * 100));
      set("[data-gpu-mem]", (8 + load * 13.5).toFixed(1));
      set("[data-gpu-temp]", Math.round(44 + load * 28));
      set("[data-gpu-tps]", Math.round(12 + load * 46));
      const bar = out("[data-gpu-util-bar]");
      if (bar) bar.style.width = `${Math.round(load * 100)}%`;
    };
    show();
    if (reduce) return;
    setInterval(() => { if (running) target = Math.min(0.98, Math.max(0.28, target + (Math.random() - 0.45) * 0.35)); }, 1600);
    setInterval(() => { if (running) show(); }, 700);
    const frame = (now) => {
      if (!running) return;
      const dt = Math.min(48, now - (last || now)); last = now;
      load += (target - load) * Math.min(1, dt / 900);
      const speed = 0.12 + load * 0.95; // degrees per ms
      for (const f of fans) {
        f.a = (f.a + speed * dt) % 360;
        f.g.setAttribute("transform", `translate(${f.g.dataset.cx} ${f.g.dataset.cy}) rotate(${f.a.toFixed(1)})`);
      }
      if (Math.random() < 0.35) for (const l of leds) l.style.opacity = Math.random() < load ? (0.55 + Math.random() * 0.45).toFixed(2) : "0.12";
      const bob = Math.sin(now / 1400) * 5;
      card.style.setProperty("--bob", `${bob.toFixed(2)}px`);
      card.style.setProperty("--ry", `${(-16 + tx * 14).toFixed(2)}deg`);
      card.style.setProperty("--rx", `${(8 - ty * 10).toFixed(2)}deg`);
      requestAnimationFrame(frame);
    };
    const hero = root.closest("section") || root;
    hero.addEventListener("pointermove", (e) => {
      const r = root.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 1.2)));
      ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 1.2)));
    }, { passive: true });
    hero.addEventListener("pointerleave", () => { tx = 0; ty = 0; });
    const start = () => { if (!running && !document.hidden) { running = true; last = 0; requestAnimationFrame(frame); } };
    const stop = () => { running = false; };
    onView(root, (e) => (e.isIntersecting ? start() : stop()), { keep: true, margin: "0px" });
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  }

  function hexA(hex, a) {
    const m = hex.replace("#", "").match(/.{2}/g);
    if (!m || m.length < 3) return `rgba(216,191,148,${a})`;
    const [r, g, b] = m.map((x) => parseInt(x, 16));
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }

  function init() {
    document.querySelectorAll("canvas[data-network]").forEach(network);
    document.querySelectorAll("[data-gpu]").forEach(gpu);
    document.querySelectorAll("[data-spotlight]").forEach(spotlight);
    document.querySelectorAll("pre[data-typing]").forEach(typing);
    document.querySelectorAll("[data-draw]").forEach(drawLine);
    document.querySelectorAll("[data-count]").forEach((el) => {
      const dec = Number(el.dataset.decimals) || 0;
      onView(el, () => count(el, Number(el.dataset.count) || 0, { format: (n) => n.toFixed(dec) }));
    });
    reveal();
  }

  window.TDCCMotion = { count, ticker, stagger, reveal, reduce };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
