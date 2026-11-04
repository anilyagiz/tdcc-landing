# Production checklist

What has to be true before the two paid products take real money:
**inference** (prepaid USDC balance → `/v1` API and `/chat.html`, `src/billing.js`) and
**GPU rentals** (Stripe Connect marketplace, `src/api.js`).

## 1. Deploy

```bash
npm test                    # must be all green
npm run deploy              # tests, remote D1 migrations (incl. 0010_balance_holds), deploy
```

Migration `0010_balance_holds.sql` must be applied **before** the new Worker serves `/v1`; `npm run deploy`
does it in that order. Take a backup first: `npm run db:backup`.

## 2. Secrets and variables

| Product | Name | Where | Required |
|---|---|---|---|
| Inference | `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEYS`, `UPSTREAM_MODEL` | secrets | yes |
| Inference | `UPSTREAM_PRICE_IN`, `UPSTREAM_PRICE_OUT` (provider USD / 1M tokens) | secrets | yes; without them `/v1` answers 503 |
| Inference | `SOLANA_TREASURY` (var), `SOLANA_RPC_URL` (secret, Helius etc.) | dashboard | yes for top-ups |
| GPU | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secrets | yes for card payments |
| GPU | `MARKET_SIGNING_KEY` (`npm run keygen`) | secret | yes for tdcc API and instant machines |
| Both | `RESEND_API_KEY` | secret | strongly recommended (verification, reset, notices) |
| Both | `SENTRY_DSN` | secret | recommended |
| Both | `TURNSTILE_SITE_KEY` (var) + `TURNSTILE_SECRET` | | recommended against sign-up abuse |
| Free gateway | `ZENMUX_API_KEY`; `PROXY_KEY` to require a key; `GATEWAY_IP_DAILY_CAP` (500), `GATEWAY_DAILY_CAP` (20000) vars | secrets / vars | see §5 |

Check `PRICE_MARKUP` (default 1.5) against the provider's current prices; check that the treasury wallet
is the one you control and has a USDC token account.

## 3. Stripe

- Connect enabled, platform and hosts in regions that support **separate charges and transfers**.
- Webhook endpoint `https://<site>/api/stripe/webhook` with events `checkout.session.completed`,
  `checkout.session.expired`, `account.updated`, `charge.dispute.created`.
- A missed webhook is no longer fatal: the cron (every 10 min) and the renter's account page look
  unfinished checkouts up in Stripe, and card holds on closed requests are released by the cron.

## 4. End-to-end run in test mode (once, before going live)

GPU, with Stripe test keys:
1. Host: list a GPU → set up payouts (Express onboarding, test data) → listing becomes bookable.
2. Renter: request → pay with `4242 4242 4242 4242` → host sees the request.
3. Host accepts → payment captured. Renter cancels mid-rental → partial refund in the Stripe dashboard.
4. Book again, let it finish; after 24 h (or `UPDATE rentals SET updated_at = updated_at - 90000`) the cron
   transfers 90 % to the connected account.
5. Decline one request, let one expire → authorizations released.

Inference, on devnet or with a small mainnet amount:
1. Top up $5 with USDC from Phantom → balance credited once.
2. Create a key, `curl $SITE/v1/chat/completions -H "authorization: Bearer sk-tdcc-…"` streaming and not.
3. Fire 20 parallel requests with a ~$0.02 balance → most answer 402, balance never goes negative.

## 5. Known limits (not fixed here)

- **Free gateway `/api/v1`, `/api/anthropic`**: with the D1 binding, limits are shared across isolates
  in `rate_limits`: 30 requests/minute per IP (429 + Retry-After), `GATEWAY_IP_DAILY_CAP` per IP per UTC
  day (429) and `GATEWAY_DAILY_CAP` in total per UTC day (503 "at capacity for today"). Daily caps count
  only requests that would reach the upstream. Without D1 (or if D1 errors) only the per-isolate
  in-memory 30/minute limit applies. Without `PROXY_KEY` it is still an open proxy for the free model
  within those caps; the IP comes from `cf-connecting-ip`, and IPv6 clients are counted per /64 prefix
  so rotating addresses inside one allocation does not reset their limits.
- **`tdcc-chat/`** (separate Vercel app with self-serve free keys) has no billing; it spends provider
  credit for free. Keep `ALLOW_SELF_SERVE_KEYS=false` there or retire it in favour of `/v1` here.
- **Rate limits and holds live in D1**: every API request does a few writes. Fine for thousands of
  requests per minute; beyond that move rate limiting to Durable Objects or Workers Rate Limiting.
- **Failed host payouts** (e.g. account restricted) retry every 10 minutes and are only visible in logs
  / Sentry. Watch for `payout failed`.
- **Prompt estimate** is ~3 characters per token. Very token-dense input (some CJK, base64) can cost more
  than reserved; the real usage is still charged, so a balance can end slightly below zero and the next
  request answers 402.
- The node side (`tdcc market` in `tdcc-mesh`/`tdcc-linux`) was not changed or re-tested here.
