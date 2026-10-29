# Billing, keys and the metered API

Everything lives in the Cloudflare Worker (`src/billing.js`) and the D1
database. Money is stored as integer micro-dollars (1 USD = 1,000,000), which
is also the base unit of USDC (6 decimals), so on-chain amounts map 1:1.

## Configuration

| Name | Kind | Meaning |
|---|---|---|
| `SOLANA_TREASURY` | var | Wallet address (owner) that receives USDC top-ups. Required for top-ups. |
| `SOLANA_RPC_URL` | secret | Solana JSON-RPC endpoint (e.g. Helius). Required for top-ups. The public `api.*.solana.com` endpoints answer 403 to requests from Cloudflare Workers, so use a provider URL. |
| `SOLANA_USDC_MINT` | var | Defaults to mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. |
| `SOLANA_CLUSTER` | var | Label shown to users, default `mainnet-beta`. |
| `UPSTREAM_BASE_URL` | var | OpenAI-compatible provider base URL. |
| `UPSTREAM_API_KEYS` | secret | Comma-separated provider keys (round-robin with failover). |
| `UPSTREAM_MODEL` | var | Provider model behind `tdcc-chat`. Never shown to users. |
| `UPSTREAM_PRICE_IN` / `UPSTREAM_PRICE_OUT` | var | Provider cost in USD per 1M input / output tokens. Without both, the paid API refuses requests instead of serving them for free. |
| `PRICE_MARKUP` | var | Multiplier on provider cost, default `1.5`. |
| `MAX_TOKENS_CAP` | var | Upper bound for `max_tokens`, default `8192`. |

## Browser endpoints (session cookie, same-origin JSON)

`GET /api/billing` returns:

```json
{
  "balance": { "micro": 12345678, "usd": "12.345678" },
  "min_topup_usd": 5,
  "payments": { "method": "solana-usdc", "configured": true, "cluster": "mainnet-beta", "treasury": "…", "mint": "…" },
  "pricing": [{ "id": "tdcc-chat", "name": "TDCC Chat", "context_length": 128000, "input_per_m_usd": "0.45", "output_per_m_usd": "1.80" }],
  "api_base": "https://decentralizedcompute.company/v1",
  "keys": [{ "id": "key_…", "name": "My app", "prefix": "sk-tdcc-AbCd…wxyz", "rpm": 60, "created_at": 0, "last_used_at": null }],
  "deposits": [{ "id": "dep_…", "amount_usd": "20.00", "status": "pending", "reference": "…", "pay_url": "solana:…", "signature": null, "credited_usd": null, "created_at": 0, "expires_at": 0 }],
  "usage": [{ "created_at": 0, "model": "tdcc-chat", "source": "api", "key_prefix": "sk-tdcc-AbCd…wxyz", "prompt_tokens": 10, "completion_tokens": 20, "cost_usd": "0.000041" }],
  "totals": { "requests_30d": 1, "tokens_30d": 30, "spent_30d_usd": "0.000041" }
}
```

- `POST /api/billing/deposits` `{ "amount_usd": 20 }` → `201 { "deposit": {…} }`. Minimum 5, maximum 10,000.
  `503` when top-ups are not configured.
- `POST /api/billing/deposits/:id/check` → `{ "deposit": {…}, "balance": {…} }`. Looks the payment up on
  chain and credits it once it is finalized. Safe to call repeatedly (the browser polls every few seconds).
- `POST /api/billing/keys` `{ "name": "My app" }` → `201 { "key": "sk-tdcc-…", "record": {…} }`. The full key
  is only ever returned here.
- `DELETE /api/billing/keys/:id` → `{ "ok": true }`.
- `POST /api/chat` `{ "messages": [{ "role": "user", "content": "…" }], "temperature": 0.7 }` → a
  `text/event-stream` of OpenAI `chat.completion.chunk` objects, billed to the signed-in account. Just before
  `data: [DONE]` it sends `data: {"object":"tdcc.billing","cost_usd":"0.000041","balance_usd":"4.999959"}`.
  Errors are JSON `{ "error": "…" }` with `401` (signed out), `402` (balance too low), `429` (too fast).

## Payment flow (USDC on Solana, Solana Pay transfer request)

1. The browser creates a deposit. The server picks a random 32-byte `reference` key and returns a Solana Pay
   URL: `solana:<treasury>?amount=<usd>&spl-token=<mint>&reference=<reference>&label=TDCC&message=…`.
2. The user scans the QR code or opens the link in a wallet (Phantom, Solflare, Backpack…), which adds the
   reference key to the transfer.
3. `check` (and the cron every 10 minutes) asks the RPC for signatures that mention the reference, loads each
   transaction at `finalized` commitment and credits the USDC that actually reached an account owned by the
   treasury with the configured mint. Each transaction signature can be credited once (unique in the ledger).
4. Deposits expire after 24 hours if nothing arrives.

## API (bearer `sk-tdcc-…` key)

- `GET /v1/models`
- `POST /v1/chat/completions`: OpenAI-compatible, streaming or not. Before calling the provider the worker
  checks that the balance covers the worst case (prompt estimate + `max_tokens`); afterwards it charges the
  real usage. Insufficient balance answers `402` with `code: "insufficient_balance"`.
