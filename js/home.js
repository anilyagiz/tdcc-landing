// Home page motion: the live console in the hero, the chat and job-flow demos,
// the bento tiles, the network mosaic, count-ups, the swapping CTA word and the
// Exact Core terminal. The markup already holds every final state, so with
// reduced motion (or without JS) the page simply shows it; each scene only runs
// while it is on screen.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // The network mosaic is drawn for everyone; only its flicker is motion.
  const mosaic = $('#mosaic');
  if (mosaic) {
    mosaic.innerHTML = Array.from({ length: 32 * 5 }, () => {
      const r = Math.random();
      return `<span class="${r < 0.42 ? 'on' : r < 0.6 ? 'dc' : ''}"></span>`;
    }).join('');
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const money = (n, d = 2) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  // A scene is an async loop that runs while its element is visible. `wait`
  // rejects once the scene is paused, which unwinds the loop; it restarts from
  // the top the next time the element scrolls into view.
  class Stop extends Error {}
  function scene(el, run, { loop = true } = {}) {
    if (!el) return;
    let gen = 0, active = false, done = false;
    const start = async () => {
      if (active || done) return;
      active = true;
      const my = ++gen;
      const wait = (ms) => new Promise((res, rej) => setTimeout(() => (my === gen && active ? res() : rej(new Stop())), ms));
      try {
        do { await run(wait); } while (loop && my === gen && active);
        if (!loop) done = true;
      } catch (e) { if (!(e instanceof Stop)) throw e; }
      if (my === gen) active = false;
    };
    const stop = () => { active = false; gen++; };
    new IntersectionObserver(([en]) => (en.isIntersecting && !document.hidden ? start() : stop()), { threshold: 0.25 }).observe(el);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > 0) start();
    });
  }

  const click = async (el, wait) => {
    if (!el) return;
    el.classList.remove('click'); void el.offsetWidth; el.classList.add('click');
    await wait(450);
    el.classList.remove('click');
  };

  async function typeInto(el, text, wait, speed = 34) {
    el.textContent = '';
    const caret = document.createElement('span');
    caret.className = 'caret';
    for (const ch of text) {
      el.textContent += ch;
      el.appendChild(caret);
      await wait(speed + Math.random() * 30);
    }
    return caret;
  }

  // ---------- hero console: jobs move on, the balance goes down ----------
  scene($('#hero-demo'), async (wait) => {
    const root = $('#hero-demo');
    const bal = $('[data-bal]', root), bar = $('.side-foot .bar i', root);
    const step = $('[data-step]', root);
    const ft = $('[data-job="ft"]', root), em = $('[data-job="em"]', root), ev = $('[data-job="ev"]', root), ch = $('[data-job="ch"]', root);
    const running = $('[data-running]', root);
    const set = (meta, cls, label, value) => {
      const dot = $('.dot', meta);
      dot.className = 'dot ' + cls; dot.textContent = label;
      if (value !== undefined) $('.mono', meta).textContent = value;
      meta.closest('.job').classList.remove('pop'); void meta.offsetWidth; meta.closest('.job').classList.add('pop');
    };
    let balance = 18.42, steps = 1840, spent = 38.40, tok = 1.2, evc = 4.02;
    set(em, 'wait', 'Requeued', '$3.10'); set(ev, 'run', 'Running', '$4.02');
    for (let i = 0; i < 8; i++) {
      await wait(1300);
      steps += 40 + Math.floor(Math.random() * 30); spent += 0.62; tok += 0.03; balance -= 0.07 + Math.random() * 0.05;
      step.textContent = steps.toLocaleString('en-US');
      $('.mono', ft).textContent = `${money(spent)} / $120`;
      $('.mono', ch).textContent = `${tok.toFixed(2)}M tok`;
      bal.textContent = money(balance);
      bar.style.width = `${Math.max(20, (balance / 30) * 100)}%`;
      if (i === 2) { set(em, 'run', 'Running'); running.textContent = '8 running'; }
      if (i === 4) { evc += 0.38; set(ev, 'ok', 'Accepted', money(evc)); running.textContent = '7 running'; }
      if (i === 6) { set(em, 'ok', 'Accepted', '$3.42'); running.textContent = '6 running'; }
    }
    await wait(2200);
  });

  // ---------- chat: type, send, stream, charge ----------
  scene($('#chat-demo'), async (wait) => {
    const root = $('#chat-demo');
    const chat = $('.chat', root), composer = $('.composer', root), typed = $('.typed', composer), send = $('.send', composer);
    const bal = $('[data-bal]', root), req = $('[data-req]', root), tokEl = $('[data-tok]', root), spentEl = $('[data-spent]', root);
    const prompts = [
      ['Write a Python function that retries a request with exponential backoff.',
       'Here is a small helper using time.sleep that doubles the wait after each failure and gives up after five tries…', 612, 0.0019],
      ['Summarize this changelog in three bullet points for the release email.',
       'Sure. The release adds marketplace rentals, signs every access grant, and ships the CLI for Linux ARM64…', 438, 0.0013],
      ['Translate “your balance is running low” into Turkish and German.',
       'Turkish: “Bakiyeniz azalıyor.” German: “Ihr Guthaben wird knapp.”', 186, 0.0006],
    ];
    let balance = 4.9981, requests = 1284, tokens = 2.41, spent = 3.62;
    for (const [q, a, t, cost] of prompts) {
      chat.innerHTML = '';
      composer.classList.add('has-text');
      const caret = await typeInto(typed, q, wait);
      await wait(350);
      await click(send, wait);
      caret.remove();
      typed.textContent = 'Message TDCC Chat…'; composer.classList.remove('has-text');
      const user = document.createElement('div'); user.className = 'msg user pop'; user.textContent = q; chat.appendChild(user);
      await wait(500);
      const bot = document.createElement('div'); bot.className = 'msg bot pop streaming'; chat.appendChild(bot);
      for (const word of a.split(' ')) { bot.textContent += (bot.textContent ? ' ' : '') + word; await wait(55 + Math.random() * 50); }
      bot.classList.remove('streaming');
      const c = document.createElement('div'); c.className = 'cost pop';
      c.innerHTML = `<span>${t} tokens</span><span>·</span><b>−$${cost.toFixed(4)}</b>`;
      chat.appendChild(c);
      balance -= cost; requests += 1; tokens += t / 1e6; spent += cost;
      bal.textContent = '$' + balance.toFixed(4);
      req.textContent = requests.toLocaleString('en-US');
      tokEl.textContent = tokens.toFixed(2) + 'M';
      spentEl.textContent = money(spent);
      await wait(2600);
    }
  });

  // ---------- job flow: submit → match → run → verify ----------
  scene($('#flow-demo'), async (wait) => {
    const root = $('#flow-demo');
    const nodes = $$(':scope > .node', root), wires = $$(':scope > .wire', root);
    const [pass, fail] = $$('.branch .node', root);
    const runChip = $('.chip', nodes[2]);
    const reset = () => { root.classList.add('playing'); $$('.node', root).forEach((n) => n.classList.remove('lit', 'done', 'lose')); };
    reset();
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].classList.add('lit');
      if (i === 2 && runChip) for (let s = 1800; s <= 3000; s += 300) { runChip.textContent = `step ${s}`; await wait(260); }
      else await wait(900);
      nodes[i].classList.replace('lit', 'done');
      if (wires[i]) { wires[i].classList.remove('go'); void wires[i].offsetWidth; wires[i].classList.add('go'); await wait(560); }
    }
    pass.classList.add('lit'); fail.classList.add('lose');
    await click(pass, wait);
    await wait(1800);
    root.classList.remove('playing');
    if (runChip) runChip.textContent = 'step 1840';
    $$('.node', root).forEach((n) => n.classList.remove('lit', 'done', 'lose'));
    await wait(1400);
  });

  // ---------- bento: receipt checks, top-up, requeue timeline, chart ----------
  scene($('#receipt'), async (wait) => {
    const root = $('#receipt'), rows = $$('.lrow', root);
    root.classList.add('playing'); rows.forEach((r) => r.classList.remove('on'));
    for (const r of rows) { await wait(650); r.classList.add('on'); }
    await wait(400); root.classList.remove('playing');
    await wait(3200);
  });

  scene($('#topup'), async (wait) => {
    const opts = $$('#topup span'), go = $('#topup-go');
    for (const pick of [0, 2, 1]) {
      await wait(1100);
      opts.forEach((o, i) => o.classList.toggle('on', i === pick));
      await click(opts[pick], wait);
    }
    await wait(500);
    await click(go, wait);
    go.classList.add('ok'); go.textContent = 'Added $20 ✓';
    await wait(1800);
    go.classList.remove('ok'); go.textContent = 'Continue';
  });

  scene($('#tl'), async (wait) => {
    const root = $('#tl'), rows = $$(':scope > div', root);
    root.classList.add('playing'); rows.forEach((r) => r.classList.remove('on'));
    for (const r of rows) { await wait(r.classList.contains('re') ? 1100 : 700); r.classList.add('on'); }
    await wait(500); root.classList.remove('playing');
    await wait(3000);
  });

  scene($('#spark'), async (wait) => {
    const root = $('#spark'), bars = $$('i', root);
    bars.forEach((b, i) => b.style.setProperty('--i', i));
    root.classList.add('pre'); void root.offsetWidth;
    await wait(50); root.classList.remove('pre');
    await wait(1400);
    bars.forEach((b) => b.style.setProperty('--i', 0));
    // New day comes in on the right; the oldest drops off.
    const heights = bars.map((b) => parseFloat(b.style.height));
    for (let k = 0; k < 6; k++) {
      await wait(1500);
      heights.shift(); heights.push(Math.min(100, Math.max(40, heights[heights.length - 1] + (Math.random() * 18 - 7))));
      bars.forEach((b, i) => { b.style.height = heights[i] + '%'; });
    }
  });

  // ---------- network mosaic ----------
  if (mosaic) {
    const cells = $$('span', mosaic);
    scene(mosaic, async (wait) => {
      for (let i = 0; i < 12; i++) {
        await wait(220);
        const c = cells[Math.floor(Math.random() * cells.length)];
        const next = c.classList.contains('hot') ? 'on' : Math.random() < 0.35 ? 'hot' : Math.random() < 0.6 ? 'on' : '';
        c.className = next;
      }
    });
  }

  // ---------- count-ups ----------
  $$('[data-count]').forEach((el) => scene(el, async (wait) => {
    const to = parseFloat(el.dataset.count), dec = String(el.dataset.count).includes('.') ? 1 : 0, fmt = el.dataset.fmt;
    const t0 = performance.now(), dur = 1100;
    for (;;) {
      const p = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt.replace('{n}', (to * e).toFixed(dec));
      if (p === 1) break;
      await wait(16);
    }
  }, { loop: false }));

  // ---------- swapping word in the CTA ----------
  const swap = $('.swap');
  if (swap) scene(swap, async (wait) => {
    for (const w of swap.dataset.words.split(',')) {
      await wait(2000);
      swap.classList.add('out'); await wait(300);
      swap.textContent = w; swap.classList.remove('out');
    }
  });

  // ---------- Exact Core terminal ----------
  const term = $('#term');
  if (term) {
    // Wrap each line so it can appear on its own.
    term.innerHTML = term.innerHTML.split('\n').map((l) => `<span class="line">${l || ' '}</span>`).join('');
    const lines = $$('.line', term);
    scene(term, async (wait) => {
      term.classList.add('typing');
      lines.forEach((l) => l.classList.remove('on'));
      for (const l of lines) { await wait(/^\s*<span class="d">\d/.test(l.innerHTML) ? 420 : 240); l.classList.add('on'); }
      await wait(300);
      term.classList.remove('typing');
    }, { loop: false });
  }
})();
