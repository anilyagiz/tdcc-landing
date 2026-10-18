// Browser walk-through of the whole marketplace against `npm run dev:e2e`
// (wrangler dev with a fresh local D1 and email features switched on).
// No email leaves the machine, so confirmation and reset tokens are planted in
// the local database, hashed exactly as the API stores them.
//
//   npm run dev:e2e        # terminal 1
//   npm run test:e2e       # terminal 2
const { chromium } = require("playwright");
const crypto = require("crypto");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "http://localhost:8787";
const SHOTS = require("path").join(require("os").tmpdir(), "tdcc-marketplace-e2e");
require("fs").mkdirSync(SHOTS, { recursive: true });

const sql = (q) => execSync(`WRANGLER_SEND_METRICS=false npx wrangler d1 execute tdcc-market --local --json --command ${JSON.stringify(q)}`, { encoding: "utf8", cwd: require("path").join(__dirname, "..") });
const plantToken = (email, purpose) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("base64url");
  sql(`INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) SELECT '${hash}', id, '${purpose}', unixepoch(), unixepoch() + 3600 FROM users WHERE email = '${email}'`);
  return token;
};
const results = [];
let pagesForShots = [];
const step = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) {
    results.push(["FAIL", name, e.message.split("\n").slice(0, 3).join(" | ")]);
    let i = 0;
    for (const p of pagesForShots) await p.screenshot({ path: `${SHOTS}/fail-${results.length}-${i++}.png` }).catch(() => {});
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (w = 1280) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/status of (4|5)\d\d/.test(m.text())) errors.push(`console ${m.text()}`); });
    p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Test moderation note" : undefined));
    return p;
  };
  const signup = async (p, name, email, pw) => {
    await p.goto(BASE + "/account.html");
    await p.click('[data-auth="signup"]');
    await p.fill("#auth [name=name]", name);
    await p.fill("#auth [name=email]", email);
    await p.fill("#auth [name=password]", pw);
    await p.check("#auth [name=accept_terms]");
    await p.click("#auth-submit");
    await p.waitForSelector("#tabs:not([hidden])");
  };
  const verify = async (p, email) => {
    const t = plantToken(email, "verify");
    await p.goto(`${BASE}/confirm.html#verify=${t}`);
    await p.waitForSelector("text=Email confirmed.");
    expect(!(await p.evaluate(() => location.hash)), "token left in the address bar");
  };

  let nodeToken = null;
  const host = await mk();
  const renter = await mk(390);
  const admin = await mk();
  pagesForShots = [host, renter, admin];

  await step("Sign-up shows the confirm-your-email banner", async () => {
    await signup(host, "Hana Host", "hana@example.com", "host password 123");
    await host.waitForSelector("#verify-banner.show");
  });

  await step("Unconfirmed user cannot list a GPU and is offered a resend", async () => {
    await host.goto(BASE + "/marketplace.html#hosts");
    await host.waitForSelector("#host-region option[value=eu-central]", { state: "attached" });
    await host.fill("#host-form [name=gpu_model]", "RTX 4090");
    await host.fill("#host-form [name=vram_gb]", "24");
    await host.fill("#host-form [name=gpu_count]", "2");
    await host.fill("#host-form [name=price]", "0.35");
    await host.selectOption("#host-region", "eu-central");
    await host.fill("#host-form [name=description]", "<script>alert(1)</script> Ryzen 9");
    await host.click("#host-submit");
    await host.waitForSelector("#host-err.show");
    expect(/Confirm your email/.test(await host.textContent("#host-err")), "wrong error");
    expect(await host.isVisible("#host-err button"), "no resend button");
  });

  await step("confirm.html#verify confirms the address", async () => { await verify(host, "hana@example.com"); });

  await step("Confirmed user lists a GPU; HTML in the description is shown as text", async () => {
    await host.goto(BASE + "/marketplace.html#hosts");
    await host.waitForSelector("#host-region option[value=eu-central]", { state: "attached" });
    await host.fill("#host-form [name=gpu_model]", "RTX 4090");
    await host.fill("#host-form [name=vram_gb]", "24");
    await host.fill("#host-form [name=gpu_count]", "2");
    await host.fill("#host-form [name=price]", "0.35");
    await host.selectOption("#host-region", "eu-central");
    await host.fill("#host-form [name=description]", "<script>alert(1)</script> Ryzen 9");
    await host.click("#host-submit");
    await host.waitForSelector(".done");
    await host.waitForSelector("#rows .row");
    await host.click("#rows [data-rent]");
    expect((await host.textContent("#d-desc")).includes("<script>"), "description not shown literally");
    await host.click("#rent [data-close] >> nth=1");
  });

  await step("Second listing for filter checks (A100 80GB, us-east)", async () => {
    const r = await host.evaluate(async () => (await fetch("/api/listings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gpu_model: "A100", vram_gb: 80, gpu_count: 4, region: "us-east", host_kind: "datacenter", price: 1.2 }) })).status);
    expect(r === 201, "create failed " + r);
  });

  await step("Filters: memory chips, region, search, sort", async () => {
    await renter.goto(BASE + "/marketplace.html");
    await renter.waitForSelector("#rows .row");
    const count = async () => (await renter.$$("#rows .row")).length;
    expect((await count()) === 2, "expected 2 listings");
    await renter.click('.chips [data-vram="80"]'); expect((await count()) === 1, "80GB+ chip");
    await renter.click('.chips [data-vram="24"]'); expect((await count()) === 1, "24GB chip");
    await renter.click('.chips [data-vram="all"]');
    await renter.selectOption("#f-region", "us-east"); expect((await count()) === 1, "region filter");
    await renter.selectOption("#f-region", "all");
    await renter.fill("#f-q", "a100"); expect((await count()) === 1, "search");
    await renter.fill("#f-q", "");
    await renter.selectOption("#f-sort", "vram");
    expect((await renter.textContent("#rows .row")).includes("A100"), "sort by memory");
    await renter.check("#f-online"); expect((await count()) === 0, "online-only should hide unlinked");
    await renter.uncheck("#f-online");
  });

  await step("Edit price, pause hides the listing, resume shows it again", async () => {
    await host.goto(BASE + "/account.html#listings");
    await host.waitForSelector("[data-edit]");
    const card = host.locator("article.card", { hasText: "RTX 4090" });
    await card.locator("[data-edit]").click();
    await card.locator("[name=price]").fill("0.40");
    await card.locator("[type=submit]").click();
    await host.waitForSelector("text=$0.40");
    await host.locator("article.card", { hasText: "RTX 4090" }).locator('[data-do="pause"]').click();
    await host.waitForSelector("text=Paused");
    let pub = await (await fetch(BASE + "/api/listings")).json();
    expect(!pub.listings.some((l) => l.gpu_model === "RTX 4090"), "paused listing still public");
    await host.locator("article.card", { hasText: "RTX 4090" }).locator('[data-do="resume"]').click();
    await host.waitForSelector("article.card:has-text('RTX 4090') >> text=Listed");
    pub = await (await fetch(BASE + "/api/listings")).json();
    expect(pub.listings.find((l) => l.gpu_model === "RTX 4090").price_cents === 40, "price not saved");
  });

  await step("Link machine shows a one-time command; a heartbeat makes it online", async () => {
    await host.locator("article.card", { hasText: "RTX 4090" }).locator('[data-do="link"]').click();
    const cmd = (await host.textContent(".cmd code")).trim();
    expect(/^tdcc market link tdcc_node_/.test(cmd), "bad command " + cmd);
    const token = cmd.split(" ").pop();
    nodeToken = token;
    const hb = await fetch(BASE + "/api/node/heartbeat", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ version: "0.73.0", gpus: [{ name: "NVIDIA GeForce RTX 4090", vram_gb: 24 }] }) });
    expect(hb.status === 200, "heartbeat " + hb.status);
    await host.reload();
    await host.waitForSelector("text=Machine online");
  });

  await step("Renter signs up from the rent drawer (mobile), confirms, sends a request", async () => {
    await renter.goto(BASE + "/marketplace.html");
    await renter.waitForSelector("#rows .row");
    await renter.locator("#rows .row", { hasText: "RTX 4090" }).locator("[data-rent]").click();
    await renter.fill("#ssh", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq rob@laptop");
    await renter.click("#request");
    await renter.waitForSelector("#auth.open");
    await renter.click('#auth [data-tab="signup"]');
    await renter.fill("#auth [name=name]", "Rob Renter");
    await renter.fill("#auth [name=email]", "rob@example.com");
    await renter.fill("#auth [name=password]", "renter password 1");
    await renter.check("#auth [name=accept_terms]");
    await renter.click("#auth-submit");
    await renter.waitForSelector("#rent-err.show");
    expect(/Confirm your email/.test(await renter.textContent("#rent-err")), "renter should need confirmation");
    await verify(renter, "rob@example.com");
    await renter.goto(BASE + "/marketplace.html");
    await renter.waitForSelector("#rows .row");
    await renter.locator("#rows .row", { hasText: "RTX 4090" }).locator("[data-rent]").click();
    await renter.fill("#ssh", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq rob@laptop");
    await renter.fill("#msg", "First request");
    await renter.click("#request");
    await renter.waitForURL(/account/);
    await renter.waitForSelector(".st.pending");
    await renter.screenshot({ path: SHOTS + "/renter-pending-mobile.png", fullPage: true });
  });

  await step("Host declines; renter sees it and no host email", async () => {
    await host.goto(BASE + "/account.html#requests");
    await host.waitForSelector("[data-do=decline]");
    await host.fill(".card-actions .inp", "Busy that day");
    await host.click("[data-do=decline]");
    await host.waitForSelector(".st.declined");
    await renter.reload();
    await renter.waitForSelector(".st.declined");
    expect(!(await renter.textContent("#pane")).includes("hana@example.com"), "host email leaked on decline");
  });

  await step("Renter cancels a pending request", async () => {
    const id = await renter.evaluate(async () => {
      const { listings } = await (await fetch("/api/listings")).json();
      const l = listings.find((x) => x.gpu_model === "RTX 4090");
      const r = await fetch("/api/rentals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing_id: l.id, gpu_count: 1, hours: 2, environment: "vllm", access: "api" }) });
      return (await r.json()).rental.id;
    });
    await renter.reload();
    await renter.locator("article.card", { hasText: "vLLM" }).locator('[data-do="cancel"]').click();
    await renter.waitForSelector("article.card:has-text('vLLM') .st.cancelled");
    expect(!!id, "no id");
  });

  await step("Accept reveals contacts both ways; finish increments the track record", async () => {
    await renter.evaluate(async () => {
      const { listings } = await (await fetch("/api/listings")).json();
      const l = listings.find((x) => x.gpu_model === "RTX 4090");
      await fetch("/api/rentals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing_id: l.id, gpu_count: 2, hours: 3, environment: "custom", image: "ghcr.io/me/train:1", access: "jupyter", message: "LoRA" }) });
    });
    await host.reload();
    await host.waitForSelector("[data-do=accept]");
    await host.click("[data-do=accept]");
    await host.waitForSelector("text=rob@example.com");
    await renter.reload();
    await renter.waitForSelector("text=hana@example.com");
    const pub = await (await fetch(BASE + "/api/listings")).json();
    expect(pub.listings.find((l) => l.gpu_model === "RTX 4090").available === 0, "capacity not reserved");
    await renter.locator("article.card", { hasText: "ghcr.io/me/train:1" }).locator('[data-do="complete"]').click();
    await renter.waitForSelector("article.card:has-text('ghcr.io/me/train:1') .st.completed");
    const pub2 = await (await fetch(BASE + "/api/listings")).json();
    const l = pub2.listings.find((x) => x.gpu_model === "RTX 4090");
    expect(l.available === 2 && l.host_completed === 1, "after finish: " + JSON.stringify(l));
  });

  await step("tdcc API rental: offered by the node, requested with an owner id, connect command after acceptance", async () => {
    const joinToken = "eyJpZCI6ImUyZS10ZXN0In0";
    const hb = await fetch(BASE + "/api/node/heartbeat", { method: "POST", headers: { authorization: "Bearer " + nodeToken, "content-type": "application/json" }, body: JSON.stringify({ version: "0.74.0", gpus: [], api: { join_token: joinToken, trust_policy: "allowlist" } }) });
    expect(hb.status === 200 && Array.isArray((await hb.json()).grants), "heartbeat with API offer");
    await renter.goto(BASE + "/marketplace.html");
    await renter.waitForSelector("#rows .row");
    const row = renter.locator("#rows .row", { hasText: "RTX 4090" });
    expect((await row.textContent()).includes("tdcc API"), "listing not marked tdcc API");
    await row.locator("[data-rent]").click();
    await renter.click("#acc-tdcc");
    expect(await renter.isHidden("#sec-env"), "environment should hide for tdcc access");
    await renter.click("#request");
    await renter.waitForSelector("#rent-err.show");
    await renter.fill("#owner", "a".repeat(64));
    await renter.click("#request");
    await renter.waitForURL(/account/);
    await renter.waitForSelector("article.card:has-text('tdcc API') .st.pending");
    await host.goto(BASE + "/account.html#requests");
    await host.locator("article.card", { hasText: "tdcc owner ID" }).locator("[data-do=accept]").click();
    await host.waitForSelector("text=Your node admits this renter automatically");
    await renter.reload();
    await renter.waitForSelector(".cmd code");
    expect((await renter.textContent(".cmd code")).trim() === `tdcc client --join ${joinToken}`, "connect command");
    await renter.screenshot({ path: SHOTS + "/tdcc-connect.png", fullPage: true });
    const grants = await (await fetch(BASE + "/api/node/heartbeat", { method: "POST", headers: { authorization: "Bearer " + nodeToken, "content-type": "application/json" }, body: JSON.stringify({ version: "0.74.0", gpus: [], api: { join_token: joinToken, trust_policy: "allowlist" } }) })).json();
    expect(grants.grants.length === 1 && grants.grants[0].owner_id === "a".repeat(64), "grant not reported to the node");
    await renter.locator("article.card", { hasText: "tdcc API" }).locator('[data-do="complete"]').click();
    await renter.waitForSelector("article.card:has-text('tdcc API') .st.completed");
  });

  await step("Report, moderate (hide), owner sees the note and cannot unhide", async () => {
    await renter.goto(BASE + "/marketplace.html");
    await renter.waitForSelector("#rows .row");
    await renter.locator("#rows .row", { hasText: "A100" }).locator("[data-rent]").click();
    await renter.click("#report-open");
    await renter.fill("#report-reason", "Price looks wrong for an A100");
    await renter.click("#report-send");
    await renter.waitForSelector(".toast.show");
    await signup(admin, "Ada Admin", "admin@example.com", "admin password 12");
    expect(!(await admin.isVisible("#admin-link")), "unconfirmed admin got moderation");
    await verify(admin, "admin@example.com");
    await admin.goto(BASE + "/account.html");
    await admin.waitForSelector("#admin-link:not([hidden])");
    await admin.goto(BASE + "/admin.html");
    await admin.waitForSelector("[data-dismiss]");
    await admin.screenshot({ path: SHOTS + "/admin.png", fullPage: true });
    await admin.click("[data-hide] >> nth=0");
    await admin.waitForSelector("text=No open reports.");
    await host.goto(BASE + "/account.html#listings");
    await host.waitForSelector("text=Test moderation note");
    const r = await host.evaluate(async () => {
      const { listings } = await (await fetch("/api/my/listings")).json();
      const l = listings.find((x) => x.gpu_model === "A100");
      return (await fetch(`/api/listings/${l.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) })).status;
    });
    expect(r === 403, "owner could unhide: " + r);
  });

  await step("Suspend signs the owner out; unsuspend lets them back in", async () => {
    await admin.goto(BASE + "/admin.html");
    await admin.waitForSelector("[data-suspend]");
    await admin.click("[data-suspend] >> nth=0");
    await admin.waitForSelector("[data-unsuspend]");
    await host.goto(BASE + "/account.html");
    await host.waitForSelector(".signin");
    await admin.click("[data-unsuspend] >> nth=0");
    await admin.waitForSelector("[data-suspend]");
  });

  await step("Forgot password → reset link → new password works, old one does not", async () => {
    const p = await mk();
    await p.goto(BASE + "/account.html");
    await p.click('[data-auth="login"]');
    await p.click("#auth-forgot");
    await p.fill("#auth [name=email]", "hana@example.com");
    await p.click("#auth-submit");
    await p.waitForSelector("text=a reset link is on its way");
    const t = plantToken("hana@example.com", "reset");
    await p.goto(`${BASE}/confirm.html#reset=${t}`);
    await p.fill("[name=password]", "brand new password 9");
    await p.fill("[name=again]", "brand new password 9");
    await p.click("#f button");
    await p.waitForURL(/account/);
    await p.waitForSelector("#tabs:not([hidden])");
    const old = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: "hana@example.com", password: "host password 123" }) });
    expect(old.status === 401, "old password still works");
    await p.goto(`${BASE}/confirm.html#reset=${t}`);
    await p.fill("[name=password]", "another password 99");
    await p.fill("[name=again]", "another password 99");
    await p.click("#f button");
    await p.waitForSelector("#err.show");
  });

  await step("Settings: change password, then delete the account", async () => {
    await renter.goto(BASE + "/account.html#settings");
    await renter.fill("#pw-form [name=current_password]", "renter password 1");
    await renter.fill("#pw-form [name=new_password]", "renter password 2");
    await renter.click("#pw-form [type=submit]");
    await renter.waitForSelector("text=Password updated");
    await renter.fill("#del-form [name=password]", "renter password 2");
    await renter.click("#del-form [type=submit]");
    await renter.waitForSelector(".signin");
    const back = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: "rob@example.com", password: "renter password 2" }) });
    expect(back.status === 401, "deleted account can still sign in");
  });

  await step("Sign out", async () => {
    await admin.goto(BASE + "/account.html");
    await admin.click("#logout");
    await admin.waitForSelector(".signin");
  });

  await step("Mobile layout has no horizontal scroll", async () => {
    for (const path of ["/marketplace.html", "/account.html", "/confirm.html", "/admin.html"]) {
      await renter.goto(BASE + path);
      await renter.waitForTimeout(300);
      const w = await renter.evaluate(() => document.documentElement.scrollWidth);
      expect(w <= 390, `${path} scrollWidth ${w}`);
    }
  });

  await browser.close();
  for (const r of results) console.log(r.join("  "));
  if (errors.length) console.log("Browser errors:\n" + [...new Set(errors)].join("\n"));
  const passed = results.filter((r) => r[0] === "PASS").length;
  console.log(`${passed}/${results.length} passed; screenshots of failures in ${SHOTS}`);
  process.exit(passed === results.length && !errors.length ? 0 : 1);
})();
