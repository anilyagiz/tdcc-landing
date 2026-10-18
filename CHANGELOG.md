# Changelog

All notable landing-site and public desktop-release changes are documented here.

## [Unreleased]

### Added

- **tdcc API rentals:** listings whose node offers it (`tdcc market
  api-rentals on`, tdcc 0.74.0+) can be rented with a tdcc owner ID; the
  renter gets a `tdcc client --join …` command and access closes by itself
  when the rented hours end. Grants are Ed25519-signed when
  `MARKET_SIGNING_KEY` is set (`npm run keygen`; public key at
  `/api/market/key`).
- **Card payments with escrow (Stripe Connect, optional):** host payout
  onboarding, card authorized on request, captured on accept, released on
  decline/expiry, refunds on cancellation, payouts 24 h after the end, and
  chargebacks or disputes holding the payout.
- **Messages** between host and renter on each request, **reviews** after a
  rental (host rating on listings, renter rating for hosts), **problem
  reports** settled by admins (`admin.html` disputes table).
- **Scheduled starts** with overlap-aware capacity; requests expire after six
  days without an answer; accepted rentals complete when their hours end.
- **Listing signals:** 7-day node uptime and "hardware checked" when tdcc's
  reported GPUs match the listing.
- **Server-side search and paging** for listings (`q`, `region`,
  `min_vram`, `max_vram`, `online`, `api`, `sort`, `limit`, `offset`).
- **Account security:** two-factor sign-in (TOTP + recovery codes), device
  list and sign-out, email change via confirmation link, activity log, data
  export, optional Cloudflare Turnstile on sign-up and reset.
- **Operations:** cron trigger for expiry, cleanup, and payouts; optional
  Sentry error reports; `npm run db:backup`.

### Changed

- Privacy policy and terms describe payments, messages, reviews, security
  logs, and the robot check.
- Content-Security-Policy allows the Turnstile script and frame.

## [0.73.0] — 2026-10-17

### Added

- **GPU marketplace backend** (`src/api.js`, Cloudflare Worker + D1): accounts,
  GPU listings, rental requests with host accept/decline, contact details
  revealed only after acceptance, and `tdcc market link` node heartbeats.
- `account.html` (rentals, requests, listings, settings), `confirm.html`
  (email confirmation and password reset links), and `admin.html`
  (moderation: reports, hide/restore listings, suspend accounts).
- Email (via Resend, optional): confirmation on sign-up, password reset, and
  notifications when a request is sent, accepted, declined, or cancelled.
  Confirmed email is required to list or rent once email is configured.
- Report a listing from the rental drawer.
- `app.html` downloads: the stable tdcc 0.73.0 CLI for Linux x64 with its
  install command; the Windows desktop beta now links to 0.73.0-rc.2.

### Deploy order

Deploy the site only after the `v0.73.0` GitHub release exists, because the
App page links to its install script and checksum.

## [0.73.0-rc.1] — 2026-08-26

### Added

- Added a **Downloads** section to `app.html` with Windows x64 MSI and NSIS links.
- Added release checksum links and a clear unsigned-preview warning.
- Added a public **Changelog** section covering the desktop beta, fixes, and known limitations.
- Added versioned release metadata and GitHub Release links to the App JSON-LD.

### Release assets

The Windows release assets are published at the [`v0.73.0-rc.1` GitHub Release](https://github.com/anilyagiz/tdcc-mesh/releases/tag/v0.73.0-rc.1):

- `tdcc-desktop-0.73.0-rc.1-x86_64-pc-windows-msvc.msi`
- `tdcc-desktop-0.73.0-rc.1-x86_64-pc-windows-msvc.msi.sha256`
- `tdcc-desktop-0.73.0-rc.1-x86_64-pc-windows-msvc-setup.exe`
- `tdcc-desktop-0.73.0-rc.1-x86_64-pc-windows-msvc-setup.exe.sha256`

Linux AppImage and `.deb` links remain disabled on the landing page until those artifacts pass the Linux smoke gate. The Tauri updater is not enabled for this release candidate.
