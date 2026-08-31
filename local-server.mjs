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
 * Setup:
 *   npm install ethers better-sqlite3
 *   node --env-file=.env local-server.mjs
 *
 */
import { createServer } from "node:http";
import { ethers } from "ethers";
import Database from "better-sqlite3";

// ── Config ──────────────────────────────────────────────────────────
const RPC_URL = process.env.COPY_RPC_URL;
const VAULT_ADDRESS = process.env.COPY_VAULT_ADDRESS;
const OPERATOR_KEY = process.env.COPY_BOT_OPERATOR_PRIVATE_KEY;
const PORT = Number(process.env.PORT ?? process.env.COPY_API_PORT ?? 8788);
const DB_PATH = process.env.COPY_DB_PATH ?? "copy-trade.db";
const QTY_STEP = Number(process.env.COPY_QTY_STEP ?? 0.01);

if (!RPC_URL || !VAULT_ADDRESS || !OPERATOR_KEY) {
  console.error(
    "Missing required env vars: COPY_RPC_URL, COPY_VAULT_ADDRESS, COPY_BOT_OPERATOR_PRIVATE_KEY"
  );
  process.exit(1);
}

// ── Chain setup ─────────────────────────────────────────────────────
// Matches the CURRENT deployed contract: struct-based openPositionFor,
// 4-field accounts()/getAccount().
const VAULT_ABI = [
  "function collateralToken() view returns (address)",
  "function accounts(address user) view returns (uint256 balance, uint256 lockedInTrades, bool copyEnabled, uint256 tradeSize)",
  "function getAccount(address user) view returns (uint256 balance, uint256 lockedInTrades, bool copyEnabled, uint256 tradeSize)",
  "function settlePosition(uint256 positionId, uint256 payout)",
  "function getPosition(uint256 positionId) view returns (tuple(address user, bytes32 marketId, uint8 side, uint256 shares, uint256 collateralAtEntry, bool settled))",
  "function openPositionFor((address user, bytes32 marketId, uint8 side, uint256 collateral, address pool, address outcomeToken, uint256 yesId, uint256 noId, uint256 priceRaw, uint256 quantityRaw, uint64 expireTimestampNs) p) returns (uint256 positionId)",
  "event PositionOpened(uint256 indexed positionId, address indexed user, bytes32 marketId, uint8 side, uint256 collateral, uint256 shares)",
  "event PositionSettled(uint256 indexed positionId, address indexed user, uint256 payout, uint256 netPayout, uint256 fee)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const operatorWallet = new ethers.Wallet(OPERATOR_KEY, provider);
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

function rawPriceQty(price, quantity, dec) {
  const d = Number(dec);
  const steppedQty = Math.floor(Number(quantity) / QTY_STEP) * QTY_STEP;
  const priceRaw = ethers.parseUnits(Number(price).toFixed(d), d);
  const quantityRaw = ethers.parseUnits(steppedQty.toFixed(d), d);
  return { priceRaw, quantityRaw, steppedQty };
}

// ── Signal handling ─────────────────────────────────────────────────
async function copyForUser(wallet, signal, dec) {
  try {
    const [balance, , copyEnabled, tradeSize] = await vault
      .getAccount(wallet)
      .catch((e) => {
        log("signal", `getAccount failed for ${wallet}: ${e.message}`);
        return [0n, 0n, false, 0n];
      });
    if (!copyEnabled) {
      log("signal", `${wallet}: skip — copyEnabled is false`);
      return;
    }
    const collateralRaw = tradeSize < balance ? tradeSize : balance;
    if (collateralRaw <= 0n) {
      log(
        "signal",
        `${wallet}: skip — zero collateral (balance=${balance}, tradeSize=${tradeSize})`
      );
      return;
    }

    const collateral = Number(ethers.formatUnits(collateralRaw, dec));
    const quantity = collateral / signal.price;
    const { priceRaw, quantityRaw, steppedQty } = rawPriceQty(
      signal.price,
      quantity,
      dec
    );
    if (steppedQty <= 0) {
      log(
        "signal",
        `${wallet}: skip — steppedQty ${steppedQty} <= 0 (collateral=${collateral}, price=${signal.price})`
      );
      return;
    }

    const sideCode = signal.side === "BUY_YES" ? 0 : 1;
    const tx = await vault.openPositionFor({
      user: wallet,
      marketId: signal.marketId,
      side: sideCode,
      collateral: collateralRaw,
      pool: signal.pool,
      outcomeToken: ethers.ZeroAddress,
      yesId: 0,
      noId: 0,
      priceRaw,
      quantityRaw,
      expireTimestampNs: (() => {
        const ms = Number(signal.expiryMs ?? Date.now() + 15 * 60_000);
        return BigInt(Math.floor(ms / 1000)) * 1_000_000_000n;
      })(),
    });
    const receipt = await tx.wait();

    const opened = receipt.logs
      .map((l) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "PositionOpened");
    if (!opened)
      throw new Error(
        `tx ${receipt.hash} confirmed but no PositionOpened event`
      );

    const positionId = Number(opened.args.positionId);

    const usedCollateral = Number(
      ethers.formatUnits(opened.args.collateral, dec)
    );
    const shares = Number(ethers.formatUnits(opened.args.shares, dec));
    const entryPrice = shares > 0 ? usedCollateral / shares : signal.price;
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
      usedCollateral, // from event, not pre-tx estimate
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
      `opened position ${positionId} for ${wallet}: ${collateral} on ${signal.symbol}`
    );
  } catch (e) {
    // now catches EVERYTHING — precision throws, contract reverts, ABI mismatches
    log(
      "signal",
      `copyForUser failed for ${wallet} on ${signal.symbol}: ${
        e.shortMessage ?? e.message
      }`
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
  await Promise.allSettled(wallets.map((w) => copyForUser(w, signal, dec)));
}

// ── Settlement handling ─────────────────────────────────────────────
// Driven by the bot's push (POST /api/settlement) rather than any polling
// of chain state — this service has no ec-core access to read market
// resolution itself, so it trusts the bot's own settlement determination
// and just scales it to each user's own position size.
async function handleSettlement(settlement) {
  if (settlement.dryRun) {
    log(
      "settlement",
      `dry-run settlement for market ${settlement.marketId} — ignoring`
    );
    return;
  }
  const open = db
    .prepare(
      `SELECT * FROM copy_trades WHERE market_id = ? AND status = 'OPEN'`
    )
    .all(settlement.marketId);
  if (open.length === 0) return;
  const dec = await decimals();
  // Pre-approve once (operator wallet funds all wins in this batch)
  const tokenAddr = await vault.collateralToken();
  const token = new ethers.Contract(
    tokenAddr,
    [
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
    ],
    operatorWallet
  );
  const allowance = await token.allowance(
    operatorWallet.address,
    VAULT_ADDRESS
  );
  if (allowance < ethers.MaxUint256 / 2n) {
    await (await token.approve(VAULT_ADDRESS, ethers.MaxUint256)).wait();
    log("settlement", `approved vault MaxUint256 for collateral pulls`);
  }

  for (const trade of open) {
    try {
      const payout = trade.shares * settlement.payoutPerShare;
      const payoutRaw = ethers.parseUnits(
        Math.max(payout, 0).toFixed(dec),
        dec
      );

      const tx = await vault.settlePosition(trade.position_id, payoutRaw);
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
      log(
        "settlement",
        `position ${trade.position_id} failed: ${e.shortMessage ?? e.message}`
      );
      // leave as OPEN — a transient RPC/gas failure should retry on the next
      // settlement push for this market, not permanently give up on real
      // money. Note: since this only re-fires on another push for the SAME
      // market, a failure here currently needs a manual retry or another
      // bot-side push to recover — flagging as a follow-up, not solved yet.
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
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
function isAddress(a) {
  return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
}

const routes = {
  "GET /": async (_req, res) => json(res, 200, { ok: true }),
  "POST /api/signal": async (req, res) => {
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
    const settlement = await readBody(req);
    if (
      !settlement.marketId ||
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

  // Dashboard calls this once after the user's wallet tx (deposit/setTradeSize/
  // setCopyEnabled) confirms client-side, so the backend knows this wallet
  // exists to check on future signals. Does NOT sign or submit anything on
  // the user's behalf.
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
      FROM copy_trades GROUP BY wallet_address ORDER BY pnl DESC LIMIT 50
    `
      )
      .all();
    const { count } = db
      .prepare(
        `SELECT COUNT(DISTINCT wallet_address) as count FROM copy_trades WHERE status='OPEN'`
      )
      .get();
    return json(res, 200, {
      activeCopiers: count,
      leaderboard: rows.map((r) => ({
        wallet: r.wallet_address,
        pnl: r.pnl ?? 0,
        winRate: r.settled ? r.wins / r.settled : null,
        settledCount: r.settled,
      })),
    });
  },
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
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
  log("server", `vault: ${VAULT_ADDRESS}, operator: ${operatorWallet.address}`);
});
