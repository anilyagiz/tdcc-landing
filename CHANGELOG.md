# Changelog

All notable landing-site and public desktop-release changes are documented here.

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
