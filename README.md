# Binal Copy-Trade Service

Standalone server and smart contract that mirror [Binal Bot](https://github.com/youthisguy/dreamdex-binal-bot)'s signals into per-user positions on DreamDEX.

Users keep custody of funds in **CopyVault**. The main bot only provides signal and settlement payloads over webhooks.

[Copy Trade page](https://dreamdex-binal-bot-ftt9.onrender.com/copy-trade.html)

---

## What this service does

1. Accepts `POST /api/signal` from the main bot when Binal opens a trade.
2. For each registered wallet that is copy-enabled on-chain with idle balance, calls `openPositionFor` as the operator.
3. Accepts `POST /api/settlement` when a market resolves.
4. calls `redeemMarket` into a per-market collateral pot.
5. Calls `settlePosition` per open copy.
6. Serves read APIs for the copy client: on-chain balances plus SQLite-backed history and a leaderboard.

It does **not** compute edge, scan markets, or talk to `ec-core`. Pool address, price, and payout ratios are all provided by the main bot.

---

## Architecture

```
Binal Bot                    Copy service                 Chain
─────────                    ────────────                 ─────
placeLimit (bot's own trade)
notifyCopyService     ─────▶ POST /api/signal
                              openPositionFor    ─────────▶ CopyVault → BinaryPool
notifyCopySettlement   ─────▶ POST /api/settlement
                              redeemMarket       ─────────▶ Router.redeemNative
                              settlePosition     ─────────▶ CopyVault (pot / operator)
copy-trade.html        ◀───  GET /api/copy/me | /leaderboard
                        ────▶ deposit / withdraw / setTradeSize / setCopyEnabled
```

| Component | Role |
|---|---|
| `CopyVault.sol` | Per-user balances; operator open/settle/redeem; fee on profit only |
| `local-server.mjs` | Webhooks, operator transactions, SQLite, public read API |
| `copy-trade.html` | Wallet UI, usually hosted alongside the main dashboard |

---

## CopyVault (contract)

Each user has their own `balance`, `lockedInTrades`, `copyEnabled`, and `tradeSize`.

| Capability | Who | Notes |
|---|---|---|
| `deposit` / `withdraw` | User | `withdraw` is the kill switch — idle balance only, always available |
| `setTradeSize` / `setCopyEnabled` | User | Trade size must be set before copy can be enabled |
| `openPositionFor` | Operator | Only for opted-in users; size ≤ `tradeSize` and idle balance |
| `redeemMarket` | Operator | Once per market after resolution; fills the market's pot |
| `settlePosition` | Operator | Credits net payout to idle balance; fee taken on profit only |

**Settlement funding order:**

1. `redeemMarket(marketId, winningSide)` calls the collateral router's `redeemNative`, landing collateral in `marketPot`.
2. Each `settlePosition` spends from that pot first.
3. The operator's own balance (via `transferFrom`).

**Fees:** `(profit * feeBps) / 10_000`, capped by `MAX_FEE_BPS`.

---

## HTTP API

### Authentication

`POST /api/signal` and `POST /api/settlement` require:

```http
x-webhook-secret: <COPY_WEBHOOK_SECRET>
```

Compared with timing-safe equality. Missing or wrong secret → `401`.

Public, no auth required: `GET /`, `GET /api/copy/me`, `GET /api/copy/leaderboard`, `POST /api/copy/register`.

### `POST /api/signal`

Fired by the bot after its own fill.

```json
{
  "marketId": "0x…",
  "symbol": "ETH-0-…",
  "side": "BUY_YES",
  "price": 0.55,
  "pool": "0x…",
  "expiryMs": 1730000000000,
  "dryRun": false
}
```

Service behavior: load registered wallets → for each `copyEnabled` wallet with available collateral → `openPositionFor` → write a SQLite row.

### `POST /api/settlement`

```json
{
  "marketId": "0x…",
  "outcome": "WIN",
  "payoutPerShare": 1,
  "winningSide": 0,
  "dryRun": false
}
```

`winningSide`: `0` = Yes, `1` = No (preferred). If omitted, the service falls back to the side of the first open trade on that market — only safe when every copy took the same side.

Flow: approve the operator on the vault if needed → `redeemMarket` on `WIN`/positive payout (errors are logged, non-fatal) → `settlePosition` for each `OPEN` row on that market.

### User / dashboard

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/copy/register` | `{ "wallet": "0x…" }` — registers a wallet after its on-chain setup |
| `GET` | `/api/copy/me?wallet=0x…` | On-chain account state plus recent trades and PnL |
| `GET` | `/api/copy/leaderboard` | Ranked settled PnL across all users |

Registering alone does nothing on-chain — deposit, set trade size, and enable copy on the deployed vault are still required.

---

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `COPY_RPC_URL` | yes | RPC endpoint for the target network |
| `COPY_VAULT_ADDRESS` | yes | Deployed `CopyVault` address |
| `COPY_BOT_OPERATOR_PRIVATE_KEY` | yes | Must match the vault's configured operator |
| `COPY_WEBHOOK_SECRET` | yes | Shared with the main bot's `COPY_WEBHOOK_SECRET` |
| `PORT` / `COPY_API_PORT` | no | Default `8788` (many hosts set `PORT` automatically) |
| `COPY_DB_PATH` | no | SQLite path — point at a persistent disk in production |
| `COPY_QTY_STEP` | no | Quantity rounding step, default `0.01` |

---

## Deploy CopyVault

Constructor arguments:

```
_collateralToken     // e.g. tUSDC
_operator            // operator EOA (this service's signing key)
_feeRecipient        // fee treasury address
_feeBps              // e.g. 1000 = 10% of profit
_collateralRouter    // DreamDEX collateral router address
_venueId             // same VENUE_ID as the main bot
_operatorId          // venue operator id — often 0 if the bot leaves it unset; verify with a test redeem
```

After deploying, set `COPY_VAULT_ADDRESS` and restart this service.

---

## Run locally

```bash
npm install
# Node 20.18.x recommended for better-sqlite3
cp .env.example .env   # fill in the variables above
node --env-file=.env local-server.mjs
```

Health check: `GET http://localhost:8788/` → `{ "ok": true }`.

---

## User flow

1. Open the Copy Trade page and connect a wallet on the correct network.
2. Approve the vault and deposit.
3. Set a trade size, then enable copy.
4. The page registers the wallet via `POST /api/copy/register`.
5. On each bot signal, the service may open a position for that wallet.
6. On settlement, idle balance updates — withdraw whenever desired.

---

## Operational notes

- One operator key signs every open and settle transaction — prefer sequential opens per signal to avoid nonce races under load.
- SQLite is ephemeral on most PaaS hosts; attach a persistent disk to keep history across redeploys.
- Redeem depends on a correct router address, `venueId`, and `operatorId`. If redeem fails, settlement still proceeds via the operator's own collateral.
- The vault records `shares = quantityRaw` under a full-fill assumption — keep position sizes small relative to book depth.
- Webhooks are push-only. A downed service simply misses signals unless the bot itself retries.

---

## Security

- `/api/signal` and `/api/settlement` are not public write endpoints without a valid `x-webhook-secret`.
- The operator key can only open or settle positions for `copyEnabled` users, capped at each user's own `tradeSize`.
- The operator can never withdraw user funds.
- Keep the operator private key and webhook secret in your host's secret store.

---

## Status & disclaimer

Intended for testnet validation and educational/hackathon use. **Not audited, not financial advice.** Copy trading can lose the full amount deposited. Deployment, keys, and parameters are your responsibility.

[DreamDEX docs](https://docs.dreamdex.io)