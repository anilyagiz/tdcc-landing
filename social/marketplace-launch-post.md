# Announcement: GPU marketplace + TDCC desktop app 0.74.0 (ready to copy)

Attach: `tdcc-marketplace-launch-1080p60-share.mp4` (50 s, 1080p60, original
soundtrack) to post 1. Re-render with:

```bash
node social/launch-audio.mjs audio.wav
node social/render-launch-video.mjs tdcc-marketplace-launch-1080p60.mp4 --fps 60 --audio audio.wav
```

## Before posting (all three must be true)

1. `https://decentralizedcompute.company/marketplace.html` is served by the
   Worker: listings load and sign-up works.
2. The Windows installer is public:
   `https://github.com/anilyagiz/tdcc-landing/releases/tag/desktop-v0.74.0`.
3. The site's download section points at that release (no private links).

Best time: 16:00–18:00 Türkiye (US morning). Pin post 1.

---

## English thread (X)

**1/6** (attach the video)
```
The TDCC GPU marketplace is live.

List your GPU in two minutes. Rent one in seconds.
And the TDCC desktop app 0.74 is out for Windows.

decentralizedcompute.company/marketplace
```

**2/6**
```
For GPU owners:

1. List your GPU and set your own hourly price. Listing is free.
2. Open the TDCC app → Marketplace, paste your link token.
3. Your machine shows up online with the hardware it reports, and stays online while the app runs.
```

**3/6**
```
For builders:

Filter by memory, region and price. Send a request; when the host accepts, you get their contact and access.

Hosts running tdcc 0.74 can hand you an isolated machine with root over SSH, removed when your hours are up.
```

**4/6**
```
Trust is built in:

· reviews from both sides
· 7-day uptime measured by the machine itself
· "hardware checked" when the GPUs match the listing
· messages and problem reports on every rental
```

**5/6**
```
TDCC desktop 0.74 (Windows, beta):

· Marketplace screen: link your GPU without a terminal
· runs the tdcc node in the background, tray icon, console in a window
· new look

Free download: github.com/anilyagiz/tdcc-landing/releases/tag/desktop-v0.74.0
Not code-signed yet: Windows shows "unknown publisher" → More info → Run anyway.
```

**6/6**
```
Most tokens are looking for a product. $COMPUTE has one.

Marketplace, desktop app, chat, research: one network.

Not financial advice. The only official contract address is the one posted by @computecompany.
```

---

## Türkçe (tek post, Türk topluluğu / Telegram)

```
TDCC GPU Marketplace yayında. 🚀

• GPU'nu 2 dakikada listele, saatlik fiyatını sen belirle. Listeleme ücretsiz.
• GPU kiralamak isteyen: bellek, bölge ve fiyata göre filtrele, talep gönder; ev sahibi onaylayınca erişimin hazır.
• Değerlendirmeler, makinenin kendi ölçtüğü 7 günlük uptime ve "donanım doğrulandı" rozeti.

TDCC masaüstü uygulaması 0.74 (Windows, beta) da çıktı: Marketplace ekranından GPU'nu terminal açmadan bağla, uygulama açık kaldıkça ilanın çevrimiçi kalsın.

👉 decentralizedcompute.company/marketplace
⬇️ github.com/anilyagiz/tdcc-landing/releases/tag/desktop-v0.74.0
(Henüz kod imzalı değil: Windows "bilinmeyen yayıncı" derse Ek bilgi → Yine de çalıştır.)

Çoğu token ürün arıyor. $COMPUTE'un bir ürünü var.
Yatırım tavsiyesi değildir. Resmi kontrat adresi yalnızca @computecompany tarafından paylaşılır.
```

---

Do not add: price targets or return promises, made-up user/GPU counts,
"pay with $COMPUTE" (payments are USDC/card or between host and renter),
instant cloud GPUs or card payments (not live yet), or Linux/macOS downloads
(not published yet).

---

## "We shipped" thread (X, with `tdcc-launch-x.mp4`)

Encode the share copy from the render with
`ffmpeg -i tdcc-marketplace-launch-1080p60.mp4 -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k tdcc-launch-x.mp4`.

Post only after Solana top-ups are configured (`SOLANA_TREASURY`, `SOLANA_RPC_URL`).

**1/5** (attach the video)
```
We shipped. 🚢

The TDCC GPU marketplace is live, and the TDCC desktop app 0.74 is out for Windows.

List your GPU in two minutes. Rent one in seconds.

decentralizedcompute.company/marketplace
```

**2/5**
```
What's coming:

🟣 Tonight: Solana payments. Top up with USDC on Solana and pay for inference and GPUs.
⭐ Next week: Stellar
🔺 Next week: Avalanche

Shipping every week.
```

**3/5**
```
For GPU owners:
· list it for free, set your own hourly price
· in the desktop app, Marketplace → paste your link token
· your machine shows up online with the hardware it reports

⬇️ github.com/anilyagiz/tdcc-landing/releases/tag/desktop-v0.74.0
```

**4/5**
```
Trust is built in:
· reviews from both sides
· 7-day uptime measured by the machine itself
· a "hardware checked" badge
· messages and problem reports on every rental
```

**5/5**
```
Most tokens are looking for a product. $COMPUTE has one, and it ships.

Not financial advice. The only official contract address is the one posted by @computecompany.
```
