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
const CUTOFF_BUFFER_MS = 3 * 60 * 1000; // Stop 3 minutes before expiry

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
      return `Unknown Custom Error [Selector: ${rawData.slice(0, 10)}]`;
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

// ── Transaction Queue & Retry Setup ─────────────────────────────────
let txQueue = Promise.resolve();

function queueTx(txFn) {
  const next = txQueue.then(() => txFn());
  txQueue = next.catch(() => {});
  return next;
}

async function executeTxWithRetry(txFn, maxRetries = 3, initialDelayMs = 200) {
  return queueTx(async () => {
    let attempt = 0;
    while (true) {
      try {
        return await txFn();
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
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  });
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
  db.prepare(
    `INSERT INTO users (wallet_address, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(wallet_address) DO NOTHING`
  ).run(wallet, now, now);
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

function rawPriceQty(price, quantity, dec) {
  const d = Number(dec);
  let steppedQty = Math.floor(Number(quantity) / QTY_STEP) * QTY_STEP;
  if (steppedQty < QTY_STEP && Number(quantity) >= QTY_STEP * 0.5) {
    steppedQty = QTY_STEP;
  }
  const priceRaw = ethers.parseUnits(Number(price).toFixed(d), d);
  const quantityRaw = ethers.parseUnits(steppedQty.toFixed(d), d);
  return { priceRaw, quantityRaw, steppedQty };
}

// ── Signal handling ─────────────────────────────────────────────────
async function copyForUser(wallet, signal, dec, collateralRaw) {
  if (!collateralRaw || collateralRaw <= 0n) return;

  const MAX_SIGNAL_AGE_MS = 6 * 60 * 1000; // Hard TTL limit (6 minutes from signal creation)
  const ABSOLUTE_MAX_PRICE = 0.9; // Never fill higher than 0.90 (capped against drift)

  const basePrice = Number(signal.price);
  const signalTimestamp = Number(signal.timestamp ?? Date.now());

  // 1. Cap maximum aggressive price at 0.90
  const maxPriceCap = Math.min(
    Number(process.env.COPY_MAX_PRICE ?? ABSOLUTE_MAX_PRICE),
    ABSOLUTE_MAX_PRICE
  );

  if (basePrice >= maxPriceCap) {
    log(
      "signal",
      `${wallet}: skip — base price ${basePrice} is at or above cap ${maxPriceCap}`
    );
    return;
  }

  // 2. Initial signal freshness check
  if (Date.now() - signalTimestamp > MAX_SIGNAL_AGE_MS) {
    log("signal", `${wallet}: skip — signal is stale`);
    return;
  }

  // 3. Setup window expiry and cutoff window (defaults to 15m window)
  const expiryMs = Number(signal.expiryMs ?? Date.now() + 15 * 60_000);
  const cutoffTimestamp = expiryMs - CUTOFF_BUFFER_MS;

  const defaultBufferPrice = basePrice + Math.max(0.02, basePrice * 0.25);
  const initialLimitPrice = Number(signal.limitPrice ?? defaultBufferPrice);
  const targetPrice = Math.min(maxPriceCap, initialLimitPrice);

  // 3-Step Sizing Ladder (prices guaranteed <= 0.90)
  const attempts = [
    {
      price: targetPrice,
      scale: 1.0,
      label: `100% @ ${targetPrice.toFixed(4)}`,
    },
    {
      price: maxPriceCap,
      scale: 0.75,
      label: `75% @ ${maxPriceCap.toFixed(2)}`,
    },
    {
      price: maxPriceCap,
      scale: 0.5,
      label: `50% @ ${maxPriceCap.toFixed(2)}`,
    },
  ];

  // 4. Polling loop: Runs until 2 mins before expiry or until TTL breaches
  while (Date.now() < cutoffTimestamp) {
    // Abandon if loop exceeds 2-minute signal TTL
    if (Date.now() - signalTimestamp > MAX_SIGNAL_AGE_MS) {
      log(
        "signal",
        `${wallet}: abandoned retry loop — reached TTL limit for ${signal.symbol}`
      );
      return;
    }

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];

      // Double guard: Skip tier if calculated target exceeds 0.90
      if (attempt.price > ABSOLUTE_MAX_PRICE) continue;

      const currentColRaw =
        (collateralRaw * BigInt(Math.round(attempt.scale * 100))) / 100n;

      if (currentColRaw <= 0n) break;

      const colNum = Number(ethers.formatUnits(currentColRaw, dec));
      const quantity = colNum / attempt.price;
      const { priceRaw, quantityRaw, steppedQty } = rawPriceQty(
        attempt.price,
        quantity,
        dec
      );

      if (steppedQty <= 0) continue;

      const sideCode = signal.side === "BUY_YES" ? 0 : 1;
      const openParams = {
        user: wallet,
        marketId: signal.marketId,
        side: sideCode,
        collateral: currentColRaw,
        pool: signal.pool,
        outcomeToken: ethers.ZeroAddress,
        yesId: 0,
        noId: 0,
        priceRaw,
        quantityRaw,
        expireTimestampNs: BigInt(Math.floor(expiryMs / 1000)) * 1_000_000_000n,
      };

      // Step A & B: SIMULATE IN QUEUE, BROADCAST, AND WAIT FOR MINED BLOCK
      let receipt;
      let opened;

      try {
        const result = await executeTxWithRetry(async () => {
          // 1. Off-chain probe inside serial queue
          await vault.openPositionFor.staticCall(openParams);
          // 2. Broadcast transaction
          const tx = await vault.openPositionFor(openParams);
          // 3. Wait for block inclusion INSIDE queue so chain state updates for next user
          const rx = await tx.wait();
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
        // If the error has a receipt or transactionHash, it was broadcast and reverted on-chain
        if (err.receipt || err.transactionHash) {
          log(
            "signal",
            `${wallet}: tx execution failed on-chain: ${
              err.shortMessage ?? err.message
            }`
          );
          return; // Stop retrying for this user on actual on-chain revert
        }

        // Otherwise, staticCall probe rejected off-chain (no liquidity at this tier)
        // Move to the next fallback size tier or wait for the next 3s poll tick
        continue;
      }

      // Step C: RECORD IN DB — On-chain transaction succeeded

      try {
        const positionId = Number(opened.args.positionId);
        const usedCollateral = Number(
          ethers.formatUnits(opened.args.collateral, dec)
        );
        const shares = Number(ethers.formatUnits(opened.args.shares, dec));
        const entryPrice = shares > 0 ? usedCollateral / shares : basePrice;

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
          )} collateral (${attempt.label}) on ${signal.symbol}`
        );
      } catch (dbErr) {
        log(
          "signal",
          `CRITICAL: Position opened on-chain (tx: ${receipt.hash}) but DB write failed: ${dbErr.message}`
        );
      }

      return; // Fill completed — terminate loop
    }

    // Wait 3s before probing order book liquidity again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  log(
    "signal",
    `${wallet}: retry window closed for ${signal.symbol} (reached 3m expiry cutoff)`
  );
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

  // 1. Pre-fetch account states in parallel
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

      return {
        wallet: w,
        collateralRaw: rawCollateral,
      };
    })
  );

  // Filter out null / zero balance copiers
  let eligible = userAccounts.filter((u) => u !== null);

  if (eligible.length === 0) {
    log(
      "signal",
      `${signal.symbol}: no eligible copiers with available collateral`
    );
    return;
  }

  // 2. Sort by ascending trade collateral size (smaller sizes filled first)
  eligible.sort((a, b) =>
    a.collateralRaw < b.collateralRaw
      ? -1
      : a.collateralRaw > b.collateralRaw
      ? 1
      : 0
  );

  // 3. Cap aggregate collateral vs book/max limit
  const envMaxAgg = process.env.COPY_MAX_AGGREGATE_COLLATERAL;
  const maxAggregateCollateral =
    typeof signal.maxAggregateCollateral === "number"
      ? signal.maxAggregateCollateral
      : envMaxAgg
      ? Number(envMaxAgg)
      : null;

  const totalRequestedCollateral = eligible.reduce(
    (sum, item) => sum + Number(ethers.formatUnits(item.collateralRaw, dec)),
    0
  );

  let scaleFactor = 1.0;
  if (
    maxAggregateCollateral &&
    totalRequestedCollateral > maxAggregateCollateral
  ) {
    scaleFactor = maxAggregateCollateral / totalRequestedCollateral;
    log(
      "signal",
      `Aggregate size (${totalRequestedCollateral.toFixed(
        2
      )}) exceeds limit (${maxAggregateCollateral.toFixed(
        2
      )}). Scaling per-user size by ${(scaleFactor * 100).toFixed(1)}%`
    );
  }

  // 4. Serialize opens sequentially
  await Promise.allSettled(
    eligible.map((item) => {
      let finalCollateralRaw = item.collateralRaw;

      if (scaleFactor < 1.0) {
        const scaledCollateral =
          Number(ethers.formatUnits(item.collateralRaw, dec)) * scaleFactor;
        finalCollateralRaw = ethers.parseUnits(
          scaledCollateral.toFixed(dec),
          dec
        );
      }

      return copyForUser(item.wallet, signal, dec, finalCollateralRaw);
    })
  );
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

  // 1. Flexible market identifier extraction
  const targetMarket =
    settlement.marketId ||
    settlement.market_id ||
    settlement.market ||
    settlement.symbol;

  if (!targetMarket) {
    log("settlement", "Settlement failed: missing market identifier in payload.");
    return;
  }

  log("settlement", `Received settlement webhook for: "${targetMarket}"`);

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

  const dec = await decimals();

  const tokenAddr = await vault.collateralToken();
  const token = new ethers.Contract(
    tokenAddr,
    [
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
    ],
    operatorWallet
  );
  const allowance = await token.allowance(rawWallet.address, VAULT_ADDRESS);
  if (allowance < ethers.MaxUint256 / 2n) {
    const approveTx = await executeTxWithRetry(() =>
      token.approve(VAULT_ADDRESS, ethers.MaxUint256)
    );
    await approveTx.wait();
    log("settlement", `approved vault MaxUint256 for collateral pulls`);
  }

  // 3. Retry redeemMarket with delay if Oracle is lagging
  if (settlement.outcome === "WIN" || settlement.payoutPerShare > 0) {
    const sideCode =
      settlement.winningSide === "BUY_NO" || settlement.winningSide === 1
        ? 1
        : settlement.winningSide === "BUY_YES" || settlement.winningSide === 0
        ? 0
        : open[0].side === "BUY_NO"
        ? 1
        : 0;

    let redeemed = false;
    const maxRedeemAttempts = 3;

    for (let attempt = 1; attempt <= maxRedeemAttempts; attempt++) {
      try {
        const redeemTx = await executeTxWithRetry(() =>
          vault.redeemMarket(open[0].market_id, sideCode)
        );
        const redeemReceipt = await redeemTx.wait();
        log(
          "settlement",
          `redeemMarket ${open[0].market_id} side=${sideCode} tx=${redeemReceipt.hash}`
        );
        redeemed = true;
        break;
      } catch (e) {
        const parsedErr = parseRevertReason(e, vault.interface);
        log(
          "settlement",
          `redeemMarket attempt ${attempt}/${maxRedeemAttempts} failed: ${parsedErr}`
        );
        if (attempt < maxRedeemAttempts) {
          log("settlement", `Waiting 3s for oracle/market state before retrying redeemMarket...`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  // 4. Settle each user's trade
  for (const trade of open) {
    try {
      const payout = trade.shares * settlement.payoutPerShare;
      const payoutRaw = ethers.parseUnits(
        Math.max(payout, 0).toFixed(dec),
        dec
      );

      const tx = await executeTxWithRetry(() =>
        vault.settlePosition(trade.position_id, payoutRaw)
      );
      const receipt = await tx.wait();
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
      log(
        "settlement",
        `position ${trade.position_id} failed: ${parsedErr}`
      );
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

    const { count } = db.prepare(`SELECT COUNT(*) as count FROM users`).get();

    return json(res, 200, {
      activeCopiers: count ?? 0,
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
        .prepare(`SELECT position_id, symbol, market_id FROM copy_trades WHERE status = 'OPEN'`)
        .all();
      if (stuck.length > 0) {
        log("cron", `Notice: ${stuck.length} unsettled OPEN trade(s) currently in DB.`);
      }
    } catch (e) {
      log("cron", `Background check error: ${e.message}`);
    }
  }, 60_000);
});
