/**
 * Copy-trade backend — a FULLY INDEPENDENT service from the main bot's
 * monorepo.
 *
 * Everything ec-core-dependent (market lookup, pool address, settlement
 * outcome/payout ratio) is computed on the BOT side (index.ts / journal.ts,
 * which already has ec-core) and pushed here as plain data via two
 * webhooks:
 *   POST /api/signal      - a new trade signal, opens positions for opted-in users
 *   POST /api/settlement  - a market resolved, settles all open positions on it
 *
 */
import { createServer } from "node:http";
import { ethers, NonceManager } from "ethers";
import Database from "better-sqlite3";
import { timingSafeEqual } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────
const RPC_URL = process.env.COPY_RPC_URL;
const VAULT_ADDRESS = process.env.COPY_VAULT_ADDRESS;
const OPERATOR_KEY = process.env.COPY_BOT_OPERATOR_PRIVATE_KEY;
const PORT = Number(process.env.PORT ?? process.env.COPY_API_PORT ?? 8788);
const DB_PATH = process.env.COPY_DB_PATH ?? "copy-trade.db";
const QTY_STEP = Number(process.env.COPY_QTY_STEP ?? 0.01);
const WEBHOOK_SECRET = process.env.COPY_WEBHOOK_SECRET;
const POLL_INTERVAL_MS = 3_000; // Check order book every 3 seconds
const CUTOFF_BUFFER_MS = 1 * 60 * 1000; // Stop 1 minutes before expiry
const RPC_READ_TIMEOUT_MS = Number(
  process.env.COPY_RPC_READ_TIMEOUT_MS ?? 15_000
);
const RPC_TX_TIMEOUT_MS = Number(process.env.COPY_RPC_TX_TIMEOUT_MS ?? 150_000);

if (!RPC_URL || !VAULT_ADDRESS || !OPERATOR_KEY) {
  console.error(
    "Missing required env vars: COPY_RPC_URL, COPY_VAULT_ADDRESS, COPY_BOT_OPERATOR_PRIVATE_KEY"
  );
  process.exit(1);
}

if (!WEBHOOK_SECRET) {
  console.error("Missing required env var: COPY_WEBHOOK_SECRET");
  process.exit(1);
}

// ── Chain setup ─────────────────────────────────────────────────────
const VAULT_ABI = [
  "function collateralToken() view returns (address)",
  "function accounts(address user) view returns (uint256 balance, uint256 lockedInTrades, bool copyEnabled, uint256 tradeSize)",
  "function getAccount(address user) view returns (uint256 balance, uint256 lockedInTrades, bool copyEnabled, uint256 tradeSize)",
  "function settlePosition(uint256 positionId, uint256 payout)",
  "function redeemMarket(bytes32 marketId, uint8 side)",
  "function getPosition(uint256 positionId) view returns (tuple(address user, bytes32 marketId, uint8 side, uint256 shares, uint256 collateralAtEntry, bool settled))",
  "function openPositionFor((address user, bytes32 marketId, uint8 side, uint256 collateral, address pool, address outcomeToken, uint256 yesId, uint256 noId, uint256 priceRaw, uint256 quantityRaw, uint64 expireTimestampNs) p) returns (uint256 positionId)",
  "event PositionOpened(uint256 indexed positionId, address indexed user, bytes32 marketId, uint8 side, uint256 collateral, uint256 shares)",
  "event PositionSettled(uint256 indexed positionId, address indexed user, uint256 payout, uint256 netPayout, uint256 fee)",

  // Custom Errors — Vault & Position validation
  "error SlippageExceeded(uint256 maxPrice, uint256 actualPrice)",
  "error PriceOutOfBounds(uint256 price, uint256 min, uint256 max)",
  "error InsufficientLiquidity()",
  "error OrderExceedsLimit()",
  "error InvalidQuantityStep(uint256 qty, uint256 step)",
  "error MarketExpired(uint256 timestamp)",
  "error Unauthorized()",
  "error BalanceTooLow(uint256 balance, uint256 required)",

  // Custom Errors — Pool, Oracle & Market Resolution
  "error MarketNotResolved()",
  "error OraclePending()",
  "error AlreadyRedeemed()",

  // Custom Errors — Matching Engine / Execution
  "error ImmediateOrCancelNoFill()",
  "error OrderAlreadyExpired()",
  "error FillOrKillNotFillable()",
  "error PostOnlyWouldCross()",
  "error SelfMatchCancelTaker()",
];

/**
 * Helper to decode custom contract errors from revert hex signatures.
 */
function parseRevertReason(err, contractInterface) {
  const rawData =
    err?.data ||
    err?.error?.data ||
    err?.payload?.data ||
    err?.info?.error?.data ||
    err?.receipt?.revertReason;

  if (rawData && typeof rawData === "string") {
    try {
      const parsed = contractInterface.parseError(rawData);
      if (parsed) {
        return parsed.args.length > 0
          ? `${parsed.name}(${parsed.args.join(", ")})`
          : `${parsed.name}()`;
      }
    } catch {
      return `Unknown Custom Error [data: ${rawData.slice(0, 74)}]`;
    }
  }

  return err?.shortMessage ?? err?.message ?? "Execution reverted";
}

function extractRevertData(err) {
  if (!err) return null;
  const candidates = [
    err?.data,
    err?.error?.data,
    err?.payload?.data,
    err?.info?.error?.data,
    err?.info?.response?.data,
    err?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) {
      return c.slice(0, 10); // 4-byte selector is enough for matching
    }
  }
  try {
    const str = `${err?.message ?? ""} ${JSON.stringify(err)}`;
    const match = str.match(/0x[a-fA-F0-9]{8}/);
    if (match) return match[0];
  } catch {}
  return null;
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const rawWallet = new ethers.Wallet(OPERATOR_KEY, provider);
const operatorWallet = new NonceManager(rawWallet);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, operatorWallet);

let collateralDecimals = null;
async function decimals() {
  if (collateralDecimals === null) {
    const tokenAddr = await vault.collateralToken();
    const token = new ethers.Contract(
      tokenAddr,
      ["function decimals() view returns (uint8)"],
      provider
    );
    collateralDecimals = Number(await token.decimals());
  }
  return collateralDecimals;
}

const log = (scope, s) =>
  console.log(`${new Date().toISOString()} [${scope}] ${s}`);

/** One in-flight settlement per marketId — repeated webhooks must not double-redeem. */
const settlementInFlight = new Map();

// Wraps a promise so a hung RPC call throws instead of stalling forever.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Transaction Queue & Retry Setup ─────────────────────────────────
let txQueue = Promise.resolve();

function queueTx(txFn) {
  const next = txQueue.then(() => txFn()).catch(() => {});
  txQueue = next;
  return next;
}

async function executeTxWithRetry(txFn, maxRetries = 3, initialDelayMs = 200) {
  let attempt = 0;
  while (true) {
    try {
      // Execute only the active broadcast inside the sequential queue lock
      return await new Promise((resolve, reject) => {
        queueTx(async () => {
          try {
            const res = await txFn();
            resolve(res);
          } catch (err) {
            reject(err);
          }
        });
      });
    } catch (err) {
      attempt++;

      // Extract raw revert data if available
      const rawData =
        err?.data ||
        err?.error?.data ||
        err?.payload?.data ||
        err?.info?.error?.data ||
        err?.receipt?.revertReason;

      const isRevert =
        err.code === "CALL_EXCEPTION" ||
        err.message?.includes("execution reverted") ||
        Boolean(rawData);

      // A tx that was broadcast but whose wait() timed out must NEVER be
      // silently retried — the original tx may still confirm later, and
      // resubmitting risks a double-send. Fail fast for manual review.
      if (err.isPostBroadcastTimeout) {
        log(
          "tx",
          `Broadcast tx ${
            err.txHash ?? "unknown"
          } timed out waiting for confirmation — NOT retrying, verify on-chain manually.`
        );
        throw err;
      }

      // Fail fast on contract execution reverts or max retries
      if (attempt >= maxRetries || isRevert) {
        throw err;
      }

      // RESYNC NONCEMANAGER: Clear cached nonce gaps on RPC network errors
      if (typeof operatorWallet.reset === "function") {
        operatorWallet.reset();
      }

      const delay = initialDelayMs * Math.pow(2, attempt - 1);
      log(
        "tx",
        `Broadcast error (attempt ${attempt}/${maxRetries}): ${
          err.shortMessage ?? err.message
        }. Retrying in ${delay}ms...`
      );

      // Delay happens OUTSIDE the queue lock so other copiers are not blocked
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ── DB setup ────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    wallet_address   TEXT PRIMARY KEY,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS copy_trades (
    position_id          INTEGER PRIMARY KEY,
    wallet_address        TEXT NOT NULL,
    market_id             TEXT NOT NULL,
    symbol                TEXT NOT NULL,
    asset                 TEXT NOT NULL,
    window                TEXT NOT NULL,
    side                  TEXT NOT NULL CHECK (side IN ('BUY_YES','BUY_NO')),
    shares                REAL NOT NULL,
    collateral_at_entry   REAL NOT NULL,
    entry_price           REAL NOT NULL,
    tx_hash               TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SETTLED','FAILED')),
    outcome               TEXT CHECK (outcome IN ('WIN','LOSS','VOID')),
    payout                REAL,
    fee                   REAL,
    net_pnl               REAL,
    settle_tx_hash        TEXT,
    source_signal_id      TEXT,
    created_at            INTEGER NOT NULL,
    settled_at            INTEGER
  );
  CREATE TABLE IF NOT EXISTS user_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address   TEXT NOT NULL,
    event            TEXT NOT NULL,
    detail           TEXT,
    tx_hash          TEXT,
    created_at       INTEGER NOT NULL
  );
`);

function upsertUser(wallet) {
  const now = Date.now();
  const w = wallet.toLowerCase();
  db.prepare(
    `INSERT INTO users (wallet_address, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(wallet_address) DO UPDATE SET updated_at = excluded.updated_at`
  ).run(w, now, now);
}

function recordEvent(wallet, event, detail, txHash) {
  db.prepare(
    `INSERT INTO user_events (wallet_address, event, detail, tx_hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(
    wallet,
    event,
    detail ? JSON.stringify(detail) : null,
    txHash ?? null,
    Date.now()
  );
}

function knownWallets() {
  return db
    .prepare(`SELECT wallet_address FROM users`)
    .all()
    .map((r) => r.wallet_address);
}

function isValidWebhookSecret(req) {
  const supplied = req.headers["x-webhook-secret"];
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Small, fixed grid steps
const PRICE_STEP = Number(process.env.COPY_PRICE_STEP ?? 0.0001); // 4dp price tick

// Cushion added on top of the deepest price level a user's fill actually
// needed, mirroring the `+0.002` cushion index.ts uses on its own IOCs —
// gives the tx a little room against the book moving between our snapshot
// and the broadcast landing.
const PRICE_BUFFER = Number(process.env.COPY_PRICE_BUFFER ?? 0.01);

function toRawUnits(human, dec, step) {
  const one = 10n ** BigInt(dec);
  const stepRaw = (one * BigInt(Math.round(step * 1e8))) / BigInt(1e8);
  const stepsPerOne = Number(one / stepRaw);
  const steps = Math.round(human * stepsPerOne);
  return BigInt(Math.max(0, steps)) * stepRaw;
}

function stepQuantityRaw(sharesHuman, dec) {
  const stepped = Math.floor(Math.max(0, sharesHuman) / QTY_STEP) * QTY_STEP;
  if (stepped <= 0) return 0n;
  return ethers.parseUnits(stepped.toFixed(Math.min(dec, 8)), dec);
}

// ── Order-book depth from the main bot ──────────────────────────────
// the bot's own live book snapshot walks price levels against REAL
// depth, then polls for new depth for anyone still short.
// BOT_ORDERBOOK_URL is the bot's own base URL, e.g.
// https://dreamdex-binal-bot-5by9.onrender.com — same host that serves the
// dashboard at /index.html. No secret needed: this route is public read-only
// market depth, same as /volume-pulse.json and /decisions.jsonl.
const BOT_ORDERBOOK_URL = process.env.BOT_ORDERBOOK_URL;
const ORDERBOOK_FETCH_TIMEOUT_MS = Number(
  process.env.COPY_ORDERBOOK_TIMEOUT_MS ?? 5_000
);
// The bot writes this roughly once per its own main-loop cycle (OF_INTERVAL_MS,
// default 8s). Older than this and we treat it as "no data" rather than
// sizing against a book that's actually gone stale.
const ORDERBOOK_MAX_AGE_MS = Number(
  process.env.COPY_ORDERBOOK_MAX_AGE_MS ?? 90_000
);
const ABSOLUTE_MAX_PRICE = 0.9; // never fill higher than 0.90, capped against drift

/**
 * Pull live ask-side depth for one outcome leg from the bot's combined
 * orderbook-snapshot.json (written every cycle by orderbook-cache.ts, served
 * by prod-server.mjs/server.mjs). Returns null (never throws) on any
 * failure — callers must treat "no book" as "wait for the next poll," never
 * as "assume it's empty" or "assume it's infinite."
 */
async function fetchAskDepth(venueSymbol) {
  if (!BOT_ORDERBOOK_URL) return null;
  try {
    const url = `${BOT_ORDERBOOK_URL}/orderbook-snapshot.json`;
    const res = await withTimeout(
      fetch(url),
      ORDERBOOK_FETCH_TIMEOUT_MS,
      "fetchAskDepth"
    );
    if (!res.ok) {
      log("orderbook", `bot returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const entry = data?.books?.[venueSymbol];
    if (!entry) return null; // bot hasn't scanned/traded this symbol recently

    const age = Date.now() - entry.updatedAt;
    if (age > ORDERBOOK_MAX_AGE_MS) {
      log(
        "orderbook",
        `snapshot for ${venueSymbol} is stale (${Math.round(
          age / 1000
        )}s old) — treating as no data`
      );
      return null;
    }
    return Array.isArray(entry.asks) ? entry.asks : null; // [[price, amount], ...] ascending
  } catch (e) {
    log("orderbook", `fetch failed: ${e.message}`);
    return null;
  }
}

/**
 * Greedily allocate available ask depth across users in priority order
 * (callers pass smallest-remaining-first, so a big account's fill doesn't
 * eat depth that would otherwise have covered several small ones). Each
 * user walks up price levels only as far as THEIR OWN remaining collateral
 * needs — whoever's first in line doesn't pay the whole book's worst
 * price, only what their own chunk required. Mutates `levels` in place
 * (consuming `.amount` as it's allocated) so later calls in the same tick,
 * or the next poll tick, see what's actually left.
 *
 * Returns fills to submit; reduces each user's `remainingCollateralRaw` by
 * whatever got allocated. Whatever's left stays queued for the next tick.
 */
function planFillsAgainstBook(users, levels, maxPrice, dec) {
  const plan = [];
  for (const user of users) {
    if (user.remainingCollateralRaw <= 0n) continue;

    let collateralLeft = Number(
      ethers.formatUnits(user.remainingCollateralRaw, dec)
    );
    let sharesGot = 0;
    let worstPrice = 0;

    for (const lvl of levels) {
      if (collateralLeft <= 0) break;
      if (lvl.price > maxPrice || lvl.amount <= 0) continue;
      const affordable = collateralLeft / lvl.price;
      const take = Math.min(affordable, lvl.amount);
      if (take <= 0) continue;
      sharesGot += take;
      collateralLeft -= take * lvl.price;
      worstPrice = Math.max(worstPrice, lvl.price);
      lvl.amount -= take; // consume — next user in this tick sees less
    }

    if (sharesGot <= 0) continue;

    const bufferedPrice = Math.min(maxPrice, worstPrice + PRICE_BUFFER);
    const priceRaw = toRawUnits(bufferedPrice, dec, PRICE_STEP);
    if (priceRaw <= 0n) continue;

    // Size quantity from the LIMIT price, not the raw book prices, so
    // priceRaw * quantityRaw never exceeds the collateral we commit.
    const one = 10n ** BigInt(dec);
    const maxQtyFromCollateral = (user.remainingCollateralRaw * one) / priceRaw;
    const maxSharesHuman = Number(
      ethers.formatUnits(maxQtyFromCollateral, dec)
    );
    const quantityRaw = stepQuantityRaw(
      Math.min(sharesGot, maxSharesHuman),
      dec
    );
    if (quantityRaw <= 0n) continue;

    let collateralRaw = (quantityRaw * priceRaw) / one;
    // Floor division can still leave 1 wei of slack; clamp hard.
    if (collateralRaw > user.remainingCollateralRaw) {
      collateralRaw = user.remainingCollateralRaw;
    }
    // Skip dust — vault can still emit PositionOpened with ~0 shares.
    const minCollateralRaw = ethers.parseUnits("0.01", dec);
    if (collateralRaw < minCollateralRaw) continue;

    plan.push({ wallet: user.wallet, quantityRaw, priceRaw, collateralRaw });
  }
  return plan;
}

/**
 * Submit one already-sized fill for one user. Same tx-building / error-
 * handling / DB-write path the old copyForUser used — the only thing that
 * changed is where price+quantity came from (walked real depth, not a
 * blind escalating guess).
 */
async function submitFill(wallet, signal, dec, fill) {
  const sideCode = signal.side === "BUY_YES" ? 0 : 1;
  const openParams = {
    user: wallet,
    marketId: signal.marketId,
    side: sideCode,
    collateral: fill.collateralRaw,
    pool: signal.pool,
    outcomeToken: signal.outcomeToken,
    yesId: BigInt(signal.yesId),
    noId: BigInt(signal.noId),
    priceRaw: fill.priceRaw,
    quantityRaw: fill.quantityRaw,
    expireTimestampNs:
      BigInt(
        Math.floor(Number(signal.expiryMs ?? Date.now() + 15 * 60_000) / 1000)
      ) * 1_000_000_000n,
  };

  let receipt, opened;
  try {
    const result = await executeTxWithRetry(async () => {
      await withTimeout(
        vault.openPositionFor.staticCall(openParams),
        RPC_READ_TIMEOUT_MS,
        "openPositionFor.staticCall()"
      );
      const tx = await vault.openPositionFor(openParams);
      let rx;
      try {
        rx = await withTimeout(
          tx.wait(),
          RPC_TX_TIMEOUT_MS,
          `openPositionFor tx.wait() (${tx.hash})`
        );
      } catch (waitErr) {
        waitErr.isPostBroadcastTimeout = true;
        waitErr.txHash = tx.hash;
        throw waitErr;
      }
      return { tx, rx };
    });

    receipt = result.rx;
    opened = receipt.logs
      .map((l) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "PositionOpened");

    if (!opened) {
      throw new Error(
        `tx ${receipt.hash} confirmed but missing PositionOpened event`
      );
    }
  } catch (err) {
    if (err.isPostBroadcastTimeout) {
      log(
        "signal",
        `${wallet}: CRITICAL — tx ${err.txHash} broadcast but confirmation timed out. Verify on-chain manually before any retry.`
      );
      return false;
    }
    if (err.receipt || err.transactionHash) {
      log(
        "signal",
        `${wallet}: tx execution failed on-chain: ${
          err.shortMessage ?? err.message
        }`
      );
      return false;
    }
    const reason = parseRevertReason(err, vault.interface);
    log(
      "signal",
      `${wallet}: fill failed (limit ${Number(
        ethers.formatUnits(fill.priceRaw, dec)
      ).toFixed(4)}) → ${reason}`
    );
    return false;
  }

  try {
    const positionId = Number(opened.args.positionId);
    const usedCollateral = Number(
      ethers.formatUnits(opened.args.collateral, dec)
    );
    const shares = Number(ethers.formatUnits(opened.args.shares, dec));

    const MIN_COLLATERAL = Number(process.env.COPY_MIN_COLLATERAL ?? 0.01);
    if (usedCollateral < MIN_COLLATERAL || shares <= 0) {
      log(
        "signal",
        `${wallet}: ignoring dust fill position ${positionId} (collateral=${usedCollateral.toFixed(
          6
        )}, shares=${shares}) — not recording`
      );
      return false;
    }

    const entryPrice =
      shares > 0 ? usedCollateral / shares : Number(signal.price);

    db.prepare(
      `
      INSERT INTO copy_trades (
        position_id, wallet_address, market_id, symbol, asset, window, side,
        shares, collateral_at_entry, entry_price, tx_hash, status,
        source_signal_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `
    ).run(
      positionId,
      wallet,
      signal.marketId,
      signal.symbol ?? "",
      signal.asset ?? "",
      signal.window ?? "",
      signal.side,
      shares,
      usedCollateral,
      entryPrice,
      receipt.hash,
      signal.signalId ?? null,
      Date.now()
    );

    recordEvent(
      wallet,
      "position_opened",
      {
        positionId,
        marketId: signal.marketId,
        collateral: usedCollateral,
        shares,
      },
      receipt.hash
    );

    log(
      "signal",
      `opened position ${positionId} for ${wallet}: ${usedCollateral.toFixed(
        2
      )} collateral @ ${entryPrice.toFixed(4)} (book-walked) on ${
        signal.symbol
      }`
    );
    return true;
  } catch (dbErr) {
    log(
      "signal",
      `CRITICAL: Position opened on-chain (tx: ${receipt.hash}) but DB write failed: ${dbErr.message}`
    );
    return true; // it DID fill — never tell the caller to retry and risk a double-fill
  }
}

/**
 * Book-aware fill loop for one signal: on every poll tick, fetch the live
 * ask depth once, walk it across every user who still has room (smallest
 * remaining collateral first), submit whatever the book supports, then
 * sleep. Repeats until either everyone's filled or the market's own cutoff
 * arrives — so a signal that only had thin depth at first keeps checking
 * for new liquidity right up to expiry instead of giving up after one look.
 */
async function fillAgainstBook(signal, dec, users) {
  const signalPx = Number(signal.price);
  const maxSlippage = Number(process.env.COPY_MAX_SLIPPAGE ?? 0.05);
  const maxPriceCap = Math.min(
    Number(process.env.COPY_MAX_PRICE ?? ABSOLUTE_MAX_PRICE),
    ABSOLUTE_MAX_PRICE,
    Number.isFinite(signalPx) && signalPx > 0
      ? signalPx + maxSlippage
      : ABSOLUTE_MAX_PRICE
  );
  const expiryMs = Number(signal.expiryMs ?? Date.now() + 15 * 60_000);
  const cutoffTimestamp = expiryMs - CUTOFF_BUFFER_MS;

  if (!signal.venueSymbol) {
    log(
      "signal",
      `${signal.symbol}: no venueSymbol on payload — can't size against the book, skipping`
    );
    return;
  }
  if (Date.now() > cutoffTimestamp) {
    log("signal", `${signal.symbol}: skip — already past cutoff`);
    return;
  }

  let consecutiveMisses = 0;
  const MAX_CONSECUTIVE_MISSES = Number(process.env.COPY_MAX_EMPTY_TICKS ?? 8);
  let usedSignalResidual = false; // only trust the payload's own snapshot once

  while (Date.now() < cutoffTimestamp) {
    const remaining = users.filter((u) => u.remainingCollateralRaw > 0n);
    if (remaining.length === 0) break;

    let asks;
    if (!usedSignalResidual && Array.isArray(signal.remainingAsks)) {
      usedSignalResidual = true;
      asks = signal.remainingAsks.length > 0 ? signal.remainingAsks : null;
      if (!asks) {
        log(
          "signal",
          `${signal.symbol}: signal carried no residual depth — bot's own fill exhausted the book under cap`
        );
      } else {
        log(
          "signal",
          `${signal.symbol}: using post-fill residual from signal (${asks.length} level(s)) instead of polling`
        );
      }
    } else {
      asks = await fetchAskDepth(signal.venueSymbol);
    }

    if (asks) {
      const levels = asks
        .map((l) => ({ price: Number(l[0]), amount: Number(l[1]) }))
        .filter((l) => l.price > 0 && l.amount > 0);

      // Live depth under the price cap (notional ≈ price × size)
      const availableNotional = levels
        .filter((l) => l.price <= maxPriceCap)
        .reduce((s, l) => s + l.price * l.amount, 0);
      const wantNotional = remaining.reduce(
        (s, u) => s + Number(ethers.formatUnits(u.remainingCollateralRaw, dec)),
        0
      );

      // Scale a COPY for this tick only — never permanently shrink remaining
      // so later ticks can use full demand if depth recovers.
      let planUsers = remaining;
      if (availableNotional > 0 && wantNotional > availableNotional * 0.9) {
        const scale = (availableNotional * 0.9) / wantNotional;
        log(
          "signal",
          `${signal.symbol}: depth ${availableNotional.toFixed(
            2
          )} < demand ${wantNotional.toFixed(2)} — scaling plan ×${(
            scale * 100
          ).toFixed(0)}%`
        );
        planUsers = remaining.map((u) => {
          const h =
            Number(ethers.formatUnits(u.remainingCollateralRaw, dec)) * scale;
          return {
            wallet: u.wallet,
            remainingCollateralRaw: ethers.parseUnits(
              Math.max(h, 0).toFixed(Math.min(dec, 8)),
              dec
            ),
          };
        });
      }

      const plan = planFillsAgainstBook(planUsers, levels, maxPriceCap, dec);

      if (plan.length > 0) {
        log(
          "signal",
          `${signal.symbol}: book supports ${plan.length}/${
            remaining.length
          } pending copier(s) this tick (cap=${maxPriceCap.toFixed(
            3
          )} depth≈${availableNotional.toFixed(2)})`
        );
      } else {
        log(
          "signal",
          `${signal.symbol}: no fillable depth under cap ${maxPriceCap.toFixed(
            3
          )} (miss ${consecutiveMisses + 1}/${MAX_CONSECUTIVE_MISSES})`
        );
      }

      let anyOk = false;
      for (const fill of plan) {
        const ok = await submitFill(fill.wallet, signal, dec, fill);
        if (ok) {
          anyOk = true;
          consecutiveMisses = 0;
          const u = users.find((x) => x.wallet === fill.wallet);
          if (u) {
            u.remainingCollateralRaw =
              u.remainingCollateralRaw > fill.collateralRaw
                ? u.remainingCollateralRaw - fill.collateralRaw
                : 0n;
          }
        }
      }

      if (plan.length === 0 || !anyOk) {
        consecutiveMisses++;
      }
    } else {
      consecutiveMisses++;
      log(
        "signal",
        `${signal.symbol}: no book snapshot this tick — will retry (miss ${consecutiveMisses}/${MAX_CONSECUTIVE_MISSES})`
      );
    }
    if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
      log(
        "signal",
        `${signal.symbol}: giving up after ${consecutiveMisses} empty ticks`
      );
      break;
    }

    if (Date.now() >= cutoffTimestamp) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const stillShort = users.filter((u) => u.remainingCollateralRaw > 0n);
  if (stillShort.length > 0) {
    log(
      "signal",
      `${signal.symbol}: cutoff reached with ${stillShort.length} copier(s) still short of full size`
    );
  }
}

async function handleSignal(signal) {
  if (signal.dryRun) {
    log("signal", `dry-run signal for ${signal.symbol} — not copy-trading`);
    return;
  }
  if (!signal.pool || signal.pool === ethers.ZeroAddress) {
    log(
      "signal",
      `signal for ${signal.symbol} missing a pool address — skipping`
    );
    return;
  }
  const dec = await decimals();
  const wallets = knownWallets();
  log(
    "signal",
    `${signal.symbol} ${signal.side} — checking ${wallets.length} known wallet(s)`
  );

  const userAccounts = await Promise.all(
    wallets.map(async (w) => {
      const [balance, , copyEnabled, tradeSize] = await vault
        .getAccount(w)
        .catch((e) => {
          log("signal", `getAccount failed for ${w}: ${e.message}`);
          return [0n, 0n, false, 0n];
        });
      if (!copyEnabled) return null;
      const rawCollateral = tradeSize < balance ? tradeSize : balance;
      if (rawCollateral <= 0n) return null;
      return { wallet: w, remainingCollateralRaw: rawCollateral };
    })
  );

  let eligible = userAccounts.filter((u) => u !== null);
  if (eligible.length === 0) {
    log(
      "signal",
      `${signal.symbol}: no eligible copiers with available collateral`
    );
    return;
  }

  // Smallest requested size first — protects small accounts from getting
  // starved behind one big account soaking up all available depth.
  eligible.sort((a, b) =>
    a.remainingCollateralRaw < b.remainingCollateralRaw
      ? -1
      : a.remainingCollateralRaw > b.remainingCollateralRaw
      ? 1
      : 0
  );

  const envMaxAgg = process.env.COPY_MAX_AGGREGATE_COLLATERAL;
  const maxAggregateCollateral =
    typeof signal.maxAggregateCollateral === "number"
      ? signal.maxAggregateCollateral
      : envMaxAgg
      ? Number(envMaxAgg)
      : null;

  const totalRequestedCollateral = eligible.reduce(
    (sum, item) =>
      sum + Number(ethers.formatUnits(item.remainingCollateralRaw, dec)),
    0
  );

  if (
    maxAggregateCollateral &&
    totalRequestedCollateral > maxAggregateCollateral
  ) {
    const scaleFactor = maxAggregateCollateral / totalRequestedCollateral;
    log(
      "signal",
      `Aggregate size (${totalRequestedCollateral.toFixed(
        2
      )}) exceeds limit (${maxAggregateCollateral.toFixed(
        2
      )}). Scaling per-user size by ${(scaleFactor * 100).toFixed(1)}%`
    );
    for (const item of eligible) {
      const scaled =
        Number(ethers.formatUnits(item.remainingCollateralRaw, dec)) *
        scaleFactor;
      item.remainingCollateralRaw = ethers.parseUnits(scaled.toFixed(dec), dec);
    }
  }

  await fillAgainstBook(signal, dec, eligible);
}

// ── Settlement handling ─────────────────────────────────────────────
async function handleSettlement(settlement) {
  if (settlement.dryRun) {
    log(
      "settlement",
      `dry-run settlement for market ${settlement.marketId} — ignoring`
    );
    return;
  }

  const targetMarket =
    settlement.marketId ||
    settlement.market_id ||
    settlement.market ||
    settlement.symbol;

  if (!targetMarket) {
    log(
      "settlement",
      "Settlement failed: missing market identifier in payload."
    );
    return;
  }

  const lockKey = String(targetMarket).toLowerCase();
  if (settlementInFlight.has(lockKey)) {
    log(
      "settlement",
      `skip — settlement already in flight for "${targetMarket}"`
    );
    return;
  }
  settlementInFlight.set(lockKey, true);
  log("settlement", `Received settlement webhook for: "${targetMarket}"`);

  try {
    await handleSettlementBody(settlement, targetMarket);
  } finally {
    settlementInFlight.delete(lockKey);
  }
}

async function handleSettlementBody(settlement, targetMarket) {
  // 2. Case-insensitive lookup across both market_id AND symbol columns
  const open = db
    .prepare(
      `SELECT * FROM copy_trades 
       WHERE (LOWER(market_id) = LOWER(?) OR LOWER(symbol) = LOWER(?)) 
         AND status = 'OPEN'`
    )
    .all(targetMarket, targetMarket);

  if (open.length === 0) {
    log(
      "settlement",
      `No open positions found in DB matching market/symbol: "${targetMarket}". Skipped.`
    );
    return;
  }

  log(
    "settlement",
    `Found ${open.length} open position(s) to settle for "${targetMarket}".`
  );

  const dec = await withTimeout(decimals(), RPC_READ_TIMEOUT_MS, "decimals()");

  const tokenAddr = await withTimeout(
    vault.collateralToken(),
    RPC_READ_TIMEOUT_MS,
    "vault.collateralToken()"
  );
  const token = new ethers.Contract(
    tokenAddr,
    [
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
    ],
    operatorWallet
  );
  const allowance = await withTimeout(
    token.allowance(rawWallet.address, VAULT_ADDRESS),
    RPC_READ_TIMEOUT_MS,
    "token.allowance()"
  );
  if (allowance < ethers.MaxUint256 / 2n) {
    const approveTx = await executeTxWithRetry(() =>
      token.approve(VAULT_ADDRESS, ethers.MaxUint256)
    );
    await withTimeout(
      approveTx.wait(),
      RPC_TX_TIMEOUT_MS,
      `approveTx.wait() (${approveTx.hash})`
    );
    log("settlement", `approved vault MaxUint256 for collateral pulls`);
  }

  // 3. Retry redeemMarket with delay if Oracle is lagging
  let sideCode = null; // ← declare here, outside the block
  if (settlement.outcome === "WIN" || settlement.payoutPerShare > 0) {
    if (
      settlement.winningSide === undefined ||
      settlement.winningSide === null
    ) {
      log(
        "settlement",
        `refusing to settle ${targetMarket}: winningSide not provided`
      );
      return;
    }
    sideCode =
      settlement.winningSide === "BUY_NO" || settlement.winningSide === 1
        ? 1
        : 0;

    let redeemed = false;
    const maxRedeemAttempts = 3;

    for (let attempt = 1; attempt <= maxRedeemAttempts; attempt++) {
      try {
        const redeemTx = await executeTxWithRetry(() =>
          vault.redeemMarket(open[0].market_id, sideCode)
        );
        let redeemReceipt;
        try {
          redeemReceipt = await withTimeout(
            redeemTx.wait(),
            RPC_TX_TIMEOUT_MS,
            `redeemTx.wait() (${redeemTx.hash})`
          );
        } catch (waitErr) {
          // Tx may still confirm — do NOT send another redeem on this attempt.
          log(
            "settlement",
            `redeemMarket wait timed out for ${redeemTx.hash} — polling receipt before retry`
          );
          for (let p = 0; p < 6; p++) {
            await new Promise((r) => setTimeout(r, 15_000));
            const mined = await provider
              .getTransactionReceipt(redeemTx.hash)
              .catch(() => null);
            if (mined) {
              if (mined.status === 1) {
                log(
                  "settlement",
                  `redeemMarket ${open[0].market_id} side=${sideCode} tx=${redeemTx.hash} confirmed late`
                );
                redeemed = true;
                break;
              }
              throw new Error(
                `redeemMarket reverted on-chain: ${redeemTx.hash}`
              );
            }
          }
          if (redeemed) break;
          throw waitErr;
        }
        log(
          "settlement",
          `redeemMarket ${open[0].market_id} side=${sideCode} tx=${redeemReceipt.hash}`
        );
        redeemed = true;
        break;
      } catch (e) {
        const parsedErr = parseRevertReason(e, vault.interface);

        // Already redeemed, or nothing to redeem (e.g. LOSS side / empty
        // inventory) — on-chain is in a state where settlePosition can run.
        // Do not abort the whole batch.
        if (
          /already redeemed/i.test(parsedErr) ||
          /AlreadyRedeemed/.test(parsedErr) ||
          /nothing to redeem/i.test(parsedErr)
        ) {
          log(
            "settlement",
            `redeemMarket: ${targetMarket} — ${parsedErr}; proceeding to settle positions`
          );
          redeemed = true;
          break;
        }

        log(
          "settlement",
          `redeemMarket attempt ${attempt}/${maxRedeemAttempts} failed: ${parsedErr}`
        );
        if (attempt < maxRedeemAttempts) {
          log(
            "settlement",
            `Waiting 3s for oracle/market state before retrying redeemMarket...`
          );
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    if (!redeemed) {
      log(
        "settlement",
        `redeemMarket never succeeded for ${targetMarket} — aborting settle, will retry on next webhook`
      );
      return;
    }
  }

  const winningSideStr =
    sideCode === 1 ? "BUY_NO" : sideCode === 0 ? "BUY_YES" : null;
  // 4. Settle each user's trade
  for (const trade of open) {
    try {
      const onchainPos = await withTimeout(
        vault.getPosition(trade.position_id),
        RPC_READ_TIMEOUT_MS,
        `vault.getPosition(${trade.position_id})`
      );
      const onchainShares = Number(ethers.formatUnits(onchainPos.shares, dec));
      if (onchainPos.settled) {
        log(
          "settlement",
          `position ${trade.position_id}: already settled on-chain, syncing DB`
        );
        db.prepare(
          `UPDATE copy_trades SET status='SETTLED' WHERE position_id=?`
        ).run(trade.position_id);
        continue;
      }
      if (Math.abs(onchainShares - trade.shares) > 1e-6) {
        log(
          "settlement",
          `position ${trade.position_id}: DB shares (${trade.shares}) != on-chain shares (${onchainShares}) — skipping, needs manual review`
        );
        continue;
      }

      const payout =
        winningSideStr && trade.side === winningSideStr
          ? trade.shares * settlement.payoutPerShare
          : 0;
      const payoutRaw = ethers.parseUnits(
        Math.max(payout, 0).toFixed(dec),
        dec
      );

      const tx = await executeTxWithRetry(() =>
        vault.settlePosition(trade.position_id, payoutRaw)
      );
      const receipt = await withTimeout(
        tx.wait(),
        RPC_TX_TIMEOUT_MS,
        `settlePosition tx.wait() (${tx.hash})`
      );
      const settled = receipt.logs
        .map((l) => {
          try {
            return vault.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "PositionSettled");

      const netPayout = settled
        ? Number(ethers.formatUnits(settled.args.netPayout, dec))
        : payout;
      const fee = settled
        ? Number(ethers.formatUnits(settled.args.fee, dec))
        : null;
      const netPnl = netPayout - trade.collateral_at_entry;

      db.prepare(
        `UPDATE copy_trades SET status='SETTLED', outcome=?, payout=?, fee=?, net_pnl=?, settle_tx_hash=?, settled_at=? WHERE position_id=?`
      ).run(
        settlement.outcome,
        payout,
        fee,
        netPnl,
        receipt.hash,
        Date.now(),
        trade.position_id
      );

      recordEvent(
        trade.wallet_address,
        "position_settled",
        { positionId: trade.position_id, outcome: settlement.outcome, netPnl },
        receipt.hash
      );
      log(
        "settlement",
        `settled position ${trade.position_id} (${trade.wallet_address}): ${
          settlement.outcome
        } ${netPnl.toFixed(3)}`
      );
    } catch (e) {
      const parsedErr = parseRevertReason(e, vault.interface);
      log("settlement", `position ${trade.position_id} failed: ${parsedErr}`);
    }
  }
}

// ── HTTP API ────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}
async function readBody(req, maxBytes = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) {
      throw new Error("Payload size exceeds limit");
    }
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
function isAddress(a) {
  return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
}

const routes = {
  "GET /": async (_req, res) => json(res, 200, { ok: true }),
  "POST /api/signal": async (req, res) => {
    if (!isValidWebhookSecret(req)) {
      log(
        "signal",
        `rejected: missing/invalid x-webhook-secret from ${req.socket.remoteAddress}`
      );
      return json(res, 401, { error: "unauthorized" });
    }
    const signal = await readBody(req);
    if (!signal.marketId || !signal.side || typeof signal.price !== "number") {
      return json(res, 400, { error: "invalid signal payload" });
    }
    handleSignal(signal).catch((e) =>
      log("signal", `handleSignal error: ${e.message}`)
    );
    return json(res, 202, { accepted: true });
  },

  "POST /api/settlement": async (req, res) => {
    if (!isValidWebhookSecret(req)) {
      log(
        "settlement",
        `rejected: missing/invalid x-webhook-secret from ${req.socket.remoteAddress}`
      );
      return json(res, 401, { error: "unauthorized" });
    }
    const settlement = await readBody(req);

    // Check for any valid market identifier key
    const targetMarket =
      settlement.marketId ||
      settlement.market_id ||
      settlement.market ||
      settlement.symbol;
    if (
      !targetMarket ||
      !settlement.outcome ||
      typeof settlement.payoutPerShare !== "number"
    ) {
      return json(res, 400, { error: "invalid settlement payload" });
    }

    handleSettlement(settlement).catch((e) =>
      log("settlement", `handleSettlement error: ${e.message}`)
    );
    return json(res, 202, { accepted: true });
  },

  "POST /api/copy/register": async (req, res) => {
    const { wallet } = await readBody(req);
    if (!isAddress(wallet))
      return json(res, 400, { error: "invalid wallet address" });
    const w = wallet.toLowerCase();
    upsertUser(w);
    recordEvent(w, "registered");
    return json(res, 200, { ok: true });
  },

  "GET /api/copy/me": async (req, res, url) => {
    const wallet = (url.searchParams.get("wallet") || "").toLowerCase();
    if (!isAddress(wallet))
      return json(res, 400, { error: "invalid wallet address" });
    const dec = await decimals();
    const [balance, lockedInTrades, copyEnabled, tradeSize] = await vault
      .getAccount(wallet)
      .catch(() => [0n, 0n, false, 0n]);
    const trades = db
      .prepare(
        `SELECT * FROM copy_trades WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(wallet);
    const settled = trades.filter((t) => t.status === "SETTLED");
    const pnl = settled.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
    const wins = settled.filter((t) => t.outcome === "WIN").length;
    return json(res, 200, {
      idleBalance: Number(ethers.formatUnits(balance, dec)),
      lockedInTrades: Number(ethers.formatUnits(lockedInTrades, dec)),
      copyEnabled,
      tradeSize: Number(ethers.formatUnits(tradeSize, dec)),
      pnl,
      winRate: settled.length ? wins / settled.length : null,
      settledCount: settled.length,
      openPositions: trades.filter((t) => t.status === "OPEN").length,
      recentTrades: trades.slice(0, 10),
    });
  },

  "GET /api/copy/leaderboard": async (_req, res) => {
    const rows = db
      .prepare(
        `
    SELECT wallet_address,
           SUM(CASE WHEN status='SETTLED' THEN net_pnl ELSE 0 END) as pnl,
           SUM(CASE WHEN status='SETTLED' AND outcome='WIN' THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN status='SETTLED' THEN 1 ELSE 0 END) as settled
    FROM copy_trades
    GROUP BY wallet_address
    ORDER BY pnl DESC
    LIMIT 50
  `
      )
      .all();

    // Only count wallets that actually have copy enabled + positive trade size on-chain
    const allWallets = knownWallets();
    let active = 0;
    const dec = await decimals();
    await Promise.all(
      allWallets.map(async (w) => {
        try {
          const [balance, , copyEnabled, tradeSize] = await vault.getAccount(w);
          if (copyEnabled && tradeSize > 0n && balance > 0n) active++;
        } catch {}
      })
    );

    return json(res, 200, {
      activeCopiers: active,
      leaderboard: rows.map((r) => ({
        wallet: r.wallet_address,
        pnl: r.pnl ?? 0,
        winRate: r.settled ? r.wins / r.settled : null,
        settledCount: r.settled,
      })),
    });
  },

  "GET /api/copy/open-trades": async (_req, res) => {
    const openTrades = db
      .prepare(
        `SELECT position_id, wallet_address, market_id, symbol, side, status, created_at 
         FROM copy_trades 
         WHERE status = 'OPEN'`
      )
      .all();
    return json(res, 200, { count: openTrades.length, openTrades });
  },
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-webhook-secret",
    });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return json(res, 404, { error: "not found" });
  try {
    await handler(req, res, url);
  } catch (e) {
    console.error(`${req.method} ${url.pathname} error:`, e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  log("server", `listening on port ${PORT}`);
  log("server", `vault: ${VAULT_ADDRESS}, operator: ${rawWallet.address}`);

  // Background interval to report stuck OPEN trades
  setInterval(() => {
    try {
      const stuck = db
        .prepare(
          `SELECT position_id, symbol, market_id FROM copy_trades WHERE status = 'OPEN'`
        )
        .all();
      if (stuck.length > 0) {
        log(
          "cron",
          `Notice: ${stuck.length} unsettled OPEN trade(s) currently in DB.`
        );
      }
    } catch (e) {
      log("cron", `Background check error: ${e.message}`);
    }
  }, 60_000);
});
