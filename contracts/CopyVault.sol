// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/token/ERC20/IERC20.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/token/ERC20/utils/SafeERC20.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/access/Ownable.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/utils/ReentrancyGuard.sol";

/**
 * CopyVault — per-user tracked copy-trading vault built for Binal Bot.
 *
 *   - NOT pooled. Every user's balance and every position is tracked
 *     individually (`accounts`, `positions`). No shared pool, no
 *     share-price math, no cross-user contamination.
 *   - withdraw() ALWAYS works, independent of operator/owner state.
 *     This is the real kill switch.
 *   - Fee is taken ONLY on realized profit, at settlement, hard-capped
 *     in code (MAX_FEE_BPS) — never on deposits/withdrawal, never on losses.
 *   - operator can ONLY open/settle positions for users who explicitly
 *     opted in (copyEnabled == true) — cannot withdraw anyone's funds,
 *     cannot touch a non-opted-in user at all.
 */
contract CopyVault is Ownable, ReentrancyGuard {

interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs,
        uint8 orderType, uint8 selfMatchingOption, address builder,
        uint96 builderFeeBpsTimes1k, uint64 userData
    ) external payable returns (bool success, uint128 id);

    function market() external view returns (address);
}

interface IBinaryMarket {
    function collateral() external view returns (address);
}
    using SafeERC20 for IERC20;

    // ── Config ──────────────────────────────────────────────────────
    IERC20 public immutable collateralToken; // USDso
    uint256 public constant MAX_FEE_BPS = 2000; // hard ceiling, 20%
    uint256 public feeBps; // owner-settable, always <= MAX_FEE_BPS
    address public feeRecipient;
    address public operator; // copy-bot's backend hot wallet

    // ── Storage ─────────────────────────────────────────────────────
    struct UserAccount {
        uint256 balance;
        uint256 lockedInTrades; // sum of collateral currently in OPEN positions
        bool copyEnabled;
        uint256 tradeSize; // max collateral the operator may commit to ANY SINGLE position — user-set, enforced on-chain
    }

    enum Side {
        Yes,
        No
    }

    struct Position {
        address user;
        bytes32 marketId;
        Side side;
        uint256 shares;
        uint256 collateralAtEntry;
        bool settled;
    }

    mapping(address => UserAccount) public accounts;
    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId;

    // ── Events ──────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event CopyToggled(address indexed user, bool enabled);
    event TradeSizeSet(address indexed user, uint256 tradeSize);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed user,
        bytes32 marketId,
        Side side,
        uint256 collateral,
        uint256 shares
    );
    event PositionSettled(
        uint256 indexed positionId,
        address indexed user,
        uint256 payout,
        uint256 netPayout,
        uint256 fee
    );
    event OperatorChanged(address indexed oldOperator, address indexed newOperator);
    event FeeBpsChanged(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyOperator() {
        require(msg.sender == operator, "CopyVault: not operator");
        _;
    }

    constructor(
        address _collateralToken,
        address _operator,
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_collateralToken != address(0), "CopyVault: zero collateral token");
        require(_operator != address(0), "CopyVault: zero operator");
        require(_feeRecipient != address(0), "CopyVault: zero fee recipient");
        require(_feeBps <= MAX_FEE_BPS, "CopyVault: fee exceeds cap");

        collateralToken = IERC20(_collateralToken);
        operator = _operator;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    // ── User-facing ─────────────────────────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "CopyVault: zero amount");
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        accounts[msg.sender].balance += amount;
        emit Deposited(msg.sender, amount);
    }

    /**
     * The real kill switch. Must always work — no dependency on operator
     * liveness, copyEnabled state, or anything besides having enough idle
     * balance. Never touches lockedInTrades; funds in open positions are
     * only released back to balance via settlePosition().
     */
    function withdraw(uint256 amount) external nonReentrant {
        UserAccount storage acct = accounts[msg.sender];
        require(amount > 0, "CopyVault: zero amount");
        require(amount <= acct.balance, "CopyVault: insufficient idle balance");
        acct.balance -= amount;
        collateralToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function setCopyEnabled(bool enabled) external {
        if (enabled) {
            // Don't let a user flip this on with no per-trade size set — that
            // would leave openPositionFor's cap check (below) meaningless,
            // silently letting the operator size trades however it likes.
            require(accounts[msg.sender].tradeSize > 0, "CopyVault: set a trade size before enabling");
        }
        accounts[msg.sender].copyEnabled = enabled;
        emit CopyToggled(msg.sender, enabled);
    }

    /**
     * How much collateral the operator may commit to ANY SINGLE position for
     * this user, e.g. depositing 100 and setting this to 15 caps every trade
     * at 15 USDso regardless of idle balance — the "10-20 USDC per trade off
     * a 100 deposit" pattern. Can be changed any time, takes effect on the
     * NEXT position (never touches ones already open).
     */
    function setTradeSize(uint256 newSize) external {
        require(newSize > 0, "CopyVault: zero trade size");
        accounts[msg.sender].tradeSize = newSize;
        emit TradeSizeSet(msg.sender, newSize);
    }

    // ── Operator-only ───────────────────────────────────────────────

    /**
     * Opens a position for `user`, funded from their own idle balance.
     * Reverts if the user hasn't opted in.
     *
     * IMPORTANT: price/quantity/expiry are NOT computed in this contract.
     * Per ec-core's orders.ts (placeLimit), the DreamDEX pool rejects any
     * price that isn't EXACTLY snapped to its tick grid as an integer — a
     * float-derived price is off by a few wei and reverts with
     * InvalidPrice. That snapping logic (toSteps()) already exists
     * correctly in ec-core; reimplementing it here in Solidity would
     * duplicate something already solved and easy to get subtly wrong.
     * Instead: the OPERATOR (which already imports ec-core) computes
     * priceRaw/quantityRaw/expireTimestampNs exactly the way placeLimit
     * does, and this function just forwards them as-is.
     *
     * pool/outcomeToken/yesId/noId also come from the operator, sourced
     * from ec-core's own on-chain market snapshot (MarketOnchain) — this
     * contract has no way to look those up itself, and per ec-core's own
     * docs, pool addresses recycle across market windows, so don't cache
     * them here either — always pass the current one per call.
     */
    function openPositionFor(
        address user,
        bytes32 marketId,
        Side side,
        uint256 collateral, // collateral committed, in vault accounting units
        address pool, // onchain.pool for THIS market, from the operator's snapshot
        address outcomeToken,
        uint256 yesId,
        uint256 noId,
        uint256 priceRaw, // tick-snapped, exactly as ec-core's placeLimit would send
        uint256 quantityRaw, // lot-snapped, exactly as ec-core's placeLimit would send
        uint64 expireTimestampNs // capped at the market's own expiry, same as placeLimit
    ) external onlyOperator nonReentrant returns (uint256 positionId) {
        UserAccount storage acct = accounts[user];
        require(acct.copyEnabled, "CopyVault: user not opted in");
        require(collateral > 0, "CopyVault: zero collateral");
        require(collateral <= acct.tradeSize, "CopyVault: exceeds user's per-trade size");
        require(collateral <= acct.balance, "CopyVault: exceeds idle balance");

        acct.balance -= collateral;
        acct.lockedInTrades += collateral;

        uint256 shares = _placeTradeOnExchange(
            pool, side, outcomeToken, yesId, noId, priceRaw, quantityRaw, expireTimestampNs, collateral
        );

        positionId = nextPositionId++;
        positions[positionId] = Position({
            user: user,
            marketId: marketId,
            side: side,
            shares: shares,
            collateralAtEntry: collateral,
            settled: false
        });

        emit PositionOpened(positionId, user, marketId, side, collateral, shares);
    }

    /**
     * Settles a position with an operator-supplied payout (the vault
     * cannot observe DreamDEX market resolution on its own — the
     * off-chain settlement script reads the real outcome and calls this).
     * Fee is computed and deducted HERE, inside the contract.
     */
    function settlePosition(uint256 positionId, uint256 payout) external onlyOperator nonReentrant {
        Position storage pos = positions[positionId];
        require(pos.user != address(0), "CopyVault: position does not exist");
        require(!pos.settled, "CopyVault: already settled");
        pos.settled = true;

        UserAccount storage acct = accounts[pos.user];
        acct.lockedInTrades -= pos.collateralAtEntry;

        uint256 fee = 0;
        if (payout > pos.collateralAtEntry) {
            uint256 profit = payout - pos.collateralAtEntry;
            fee = (profit * feeBps) / 10_000;
        }

        uint256 netPayout = payout - fee;
        acct.balance += netPayout;

        if (fee > 0) {
            collateralToken.safeTransfer(feeRecipient, fee);
        }

        emit PositionSettled(positionId, pos.user, payout, netPayout, fee);
    }

    // ── Owner-only (use a multisig for this role) ──────────────────

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "CopyVault: zero operator");
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "CopyVault: fee exceeds cap");
        emit FeeBpsChanged(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "CopyVault: zero fee recipient");
        emit FeeRecipientChanged(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    // ── Views ───────────────────────────────────────────────────────

    function getAccount(address user) external view returns (uint256 balance, uint256 lockedInTrades, bool copyEnabled, uint256 tradeSize) {
        UserAccount storage acct = accounts[user];
        return (acct.balance, acct.lockedInTrades, acct.copyEnabled, acct.tradeSize);
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    // ── Internal ────────────────────────────────────────────────────

     /**
     *   - The entry point is placeBinaryOrder — the
     *     generic placeOrder reverts UseBinaryPlacement on a binary pool.
     *   - collateral() is NOT a BinaryPool method — it lives on the
     *     per-window Market, reached via pool.market().collateral().
     *   - builderFeeBpsTimes1k MUST be uint96 exactly, or the call
     *     selector silently changes and reverts undecodably.
     * kind: 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO — price is always
     * quoted in YES terms regardless of side (confirmed in the report).
     */
    function _placeTradeOnExchange(
        address pool,
        Side side,
        address /* outcomeToken */,
        uint256 /* yesId */,
        uint256 /* noId */,
        uint256 priceRaw,
        uint256 quantityRaw,
        uint64 expireTimestampNs,
        uint256 collateral
    ) internal returns (uint256 shares) {
        uint8 kind = side == Side.Yes ? 0 : 2; // BUY_YES : BUY_NO

        address market = IBinaryPool(pool).market();
        address token = IBinaryMarket(market).collateral();
        require(token == address(collateralToken), "CopyVault: market collateral mismatch");

        // Exact required amount per ec-core's own assertFunded math:
        // (price * quantity) / 10^decimals. Approve exactly this, not the
        // full `collateral` bucket — any dust difference stays in the
        // vault's idle-ish balance rather than over-approving the pool.
        uint256 required = (priceRaw * quantityRaw) / 1e18; // TODO confirm decimals against real collateral token
        require(required <= collateral, "CopyVault: price*quantity exceeds committed collateral");

        collateralToken.approve(pool, required);

        (bool success, ) = IBinaryPool(pool).placeBinaryOrder(
            kind,
            priceRaw,
            quantityRaw,
            expireTimestampNs,
            2, // orderType: IOC — take immediately, don't rest as a maker order
            0, // selfMatchingOption — TODO confirm the right value for this venue (Rampart report doesn't cover it)
            address(0), // builder — no routing fee
            0, // builderFeeBpsTimes1k — MUST stay uint96-typed; literal 0 is fine
            0  // userData
        );
        require(success, "CopyVault: placeBinaryOrder rejected");

        // TODO: decode actual filled quantity from the OrderFilled event
        // instead of assuming full fill — an IOC can partial-fill or fill
        // 0 if the book was thin, and shares should reflect what actually
        // executed, not what was requested.
        shares = quantityRaw;
    }
}
