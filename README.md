# TDCC Minimal Deploy

This package preserves the minimalist, academic landing-page aesthetic while adding production deployment essentials for `decentralizedcompute.company`.

## Included
- Responsive dependency-free website
- `app.html` — TDCC App release page (console, CLI, SDKs, job API) with SoftwareApplication/FAQ/Breadcrumb JSON-LD
- `CHANGELOG.md` — public desktop beta release notes and release-asset checklist
- SEO metadata and canonical URLs
- Open Graph and X social cards
- JSON-LD for Organization, WebSite, Service, and FAQ
- `robots.txt`, `sitemap.xml`, RSS, PWA manifest
- GEO/AI discovery files: `llms.txt`, `llms-full.txt`, `ai.txt`, `facts.html`
- Vercel, Netlify, and generic static-hosting configuration
- Security headers and `security.txt`
- Privacy, terms, and custom 404 pages

## GPU marketplace

`marketplace.html` and `account.html` are backed by a small API in the
Cloudflare Worker (`src/api.js`) with a D1 (SQLite) database:

- Anyone can browse listings. Creating an account takes a name, email and
  password; the same account can rent GPUs and list its own.
- Hosts list a GPU from the marketplace form, then pause, edit, or remove it
  from **My account**. Optionally they link the machine with
  `tdcc market link <token>` (tdcc-mesh) so the listing shows as online with
  the GPUs the node actually reports.
- Renters send a request (count, hours, environment, access, SSH key). The
  host accepts or declines. Emails and the SSH key are only revealed to the
  other party after acceptance. No payments are processed during early access.

Security: PBKDF2-SHA256 password hashes, hashed session tokens in an
HttpOnly/Secure/SameSite `__Host-` cookie, Origin checks plus JSON-only bodies
against CSRF, D1-backed rate limits on sign-up/login/writes, server-side
validation of every field, output escaping in the pages, and single-statement
capacity checks so a listing cannot be overbooked.

### Email, password reset, and moderation

With `RESEND_API_KEY` (a secret) and `EMAIL_FROM` set, new accounts get a
confirmation link and must confirm before listing or renting, "Forgot your
password?" emails a single-use reset link, and hosts and renters are emailed
when a request is sent, accepted, declined, or cancelled. Without them, these
features say they are unavailable and nobody is blocked.

Anyone signed in can report a listing. Accounts listed in `ADMIN_EMAILS` (with
a confirmed email) get `/admin.html`: open reports, every listing, hide or
restore a listing, and suspend or unsuspend an account. Without email set up,
confirm an admin account by hand after it signs up:

```bash
npx wrangler d1 execute tdcc-market --remote \
  --command "UPDATE users SET email_verified_at = unixepoch() WHERE email = 'anil@decentralizedcompute.company'"
``` Suspending signs the
account out, hides its listings, and cancels its pending requests.

### Local development
```bash
npm install
npm test        # API tests against an in-memory SQLite stand-in for D1
npm run dev     # wrangler dev with a local D1 database on http://localhost:8787
```

### First deploy (Cloudflare Workers)
```bash
npx wrangler login
npx wrangler d1 create tdcc-market      # copy the database_id into wrangler.toml
npx wrangler secret put RESEND_API_KEY  # optional: enables email features
npm run deploy                          # tests, remote migrations, deploy
```
Static files are served from the repository root; `.assetsignore` keeps the
Worker source, migrations, and tests out of the public assets. Netlify and
Vercel can still serve the static pages, but the marketplace API needs the
Worker.

## Vercel
1. Create a new Vercel project.
2. Upload this folder or connect its Git repository.
3. Framework preset: **Other**. Build command: leave empty. Output directory: `.`
4. Add `decentralizedcompute.company` and `www.decentralizedcompute.company` under Domains.
5. Apply the DNS records Vercel displays. The included redirect sends `www` to the apex domain.

## Netlify
1. Drag this folder into Netlify Drop or connect the repository.
2. Publish directory: `.`
3. Add the apex and `www` domains.
4. Apply Netlify DNS records.

## Cloudflare Pages
1. Create a Pages project and upload/connect this folder.
2. Framework preset: none. Build command: empty. Output directory: `.`
3. Add `decentralizedcompute.company` as the custom domain.
4. Add a redirect rule for `www` to the apex domain if Cloudflare does not create it automatically.

## Before launch
- Keep versioned MSI/NSIS artifacts and `.sha256` sidecars in the matching GitHub Release; `app.html` intentionally links to GitHub instead of storing large binaries in the static site. The `v0.73.0-rc.1` Windows assets are published.
- Enable Linux download links only after the AppImage and `.deb` artifacts pass the cross-platform smoke gate.
- Configure Authenticode signing before promoting the Windows candidate beyond beta; the current release is unsigned and may trigger SmartScreen.
- Confirm ownership and DNS for `decentralizedcompute.company`.
- Replace email/social links if the project receives dedicated accounts.
- Verify the site in Google Search Console and Bing Webmaster Tools.
- Submit `/sitemap.xml`.
- Test social previews using the platform debuggers.
- Keep `facts.html` and `llms.txt` synchronized with public product claims.
