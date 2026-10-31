# Marketplace + tdcc 0.74.0 launch (ready to copy)

Video: `tdcc-marketplace-launch-1080p60.mp4` (50 s, 1920×1080, 60 fps, original
soundtrack). Re-render with:

```bash
node social/launch-audio.mjs audio.wav
node social/render-launch-video.mjs tdcc-marketplace-launch-1080p60.mp4 --fps 60 --audio audio.wav
```

Before posting: `decentralizedcompute.company` must serve the Worker (custom
domain), otherwise the marketplace page links to an API that answers "not
available". Check that `/marketplace.html` lists GPUs and sign-up works.

Best time: 16:00–18:00 Türkiye (US morning). Attach the video to post 1.

---

## 1/5 (video)

```
The GPU marketplace is live.

List your GPU in two minutes. Rent one in seconds.
And tdcc 0.74.0 is out.

decentralizedcompute.company/marketplace
```

## 2/5

```
For GPU owners:

tdcc market link <token>

Your machine shows up online, with the hardware it reports. You set the hourly price. Listing is free.
```

## 3/5

```
For builders:

Filter by memory, region and price. Send a request; the host accepts and you are in.

On hosts running tdcc 0.74, you get an isolated machine with root over SSH, removed when your hours are up.
```

## 4/5

```
Trust is built in:

· reviews from both sides
· 7-day uptime from the machine itself
· "hardware checked" when the GPUs match the listing
· messages and problem reports on every rental
```

## 5/5

```
Most tokens are looking for a product. $COMPUTE has one.

Marketplace, chat, API, desktop app, research: one network.

Not financial advice. The only official contract address is the one posted by @computecompany.
```

---

Do not add: price targets, return promises, made-up user/GPU counts, or
"pay with $COMPUTE" (marketplace and API payments are USDC/card today).
