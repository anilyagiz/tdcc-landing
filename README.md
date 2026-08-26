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

## Local preview
```bash
python -m http.server 8080
```
Open `http://localhost:8080`.

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
