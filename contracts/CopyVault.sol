// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/token/ERC20/IERC20.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
 *
 * Fill accounting:
 *   - After placeBinaryOrder, net collateral spent is measured via balance
 *     delta (handles better fill price + exchange refunds).
 *   - Unspent collateral is refunded to the user's idle balance.
 *   - shares still = quantityRaw (full-fill assumption).
 *
 * Settlement funding:
 *   - On settle, operator must have approved this vault for `payout`.
 *   - Contract pulls `payout` tUSDC from the operator, takes fee on profit,
 *     credits netPayout to the user's idle (deposited) balance for withdraw.
 */

interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function market() external view returns (address);
}

interface IBinaryMarket {
    function collateral() external view returns (address);
}

contract CopyVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Config ──────────────────────────────────────────────────────
    IERC20 public immutable collateralToken;
    uint8 public immutable collateralDecimals;
    uint256 public constant MAX_FEE_BPS = 2000;  
    uint256 public feeBps;
    address public feeRecipient;
    address public operator;

    // ── Storage ─────────────────────────────────────────────────────
    struct UserAccount {
        uint256 balance;
        uint256 lockedInTrades;
        bool copyEnabled;
        uint256 tradeSize;
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

    struct OpenPositionParams {
        address user;
        bytes32 marketId;
        Side side;
        uint256 collateral;
        address pool;
        address outcomeToken;
        uint256 yesId;
        uint256 noId;
        uint256 priceRaw;
        uint256 quantityRaw;
        uint64 expireTimestampNs;
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
        collateralDecimals = IERC20Metadata(_collateralToken).decimals();
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
     * Kill switch: always works from idle balance only.
     * Locked funds return only via settlePosition.
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
            require(
                accounts[msg.sender].tradeSize > 0,
                "CopyVault: set a trade size before enabling"
            );
        }
        accounts[msg.sender].copyEnabled = enabled;
        emit CopyToggled(msg.sender, enabled);
    }

    function setTradeSize(uint256 newSize) external {
        require(newSize > 0, "CopyVault: zero trade size");
        accounts[msg.sender].tradeSize = newSize;
        emit TradeSizeSet(msg.sender, newSize);
    }

    // ── Operator-only ───────────────────────────────────────────────

    function openPositionFor(
        OpenPositionParams calldata p
    ) external onlyOperator nonReentrant returns (uint256 positionId) {
        UserAccount storage acct = accounts[p.user];
        require(acct.copyEnabled, "CopyVault: user not opted in");
        require(p.collateral > 0, "CopyVault: zero collateral");
        require(p.collateral <= acct.tradeSize, "CopyVault: exceeds user's per-trade size");
        require(p.collateral <= acct.balance, "CopyVault: exceeds idle balance");

        // Lock full committed collateral up front
        acct.balance -= p.collateral;
        acct.lockedInTrades += p.collateral;

        (uint256 shares, uint256 usedCollateral) = _placeTradeOnExchange(
            p.pool,
            p.side,
            p.outcomeToken,
            p.yesId,
            p.noId,
            p.priceRaw,
            p.quantityRaw,
            p.expireTimestampNs,
            p.collateral
        );

        // Refund unspent collateral (better fill price / partial notional)
        if (usedCollateral < p.collateral) {
            uint256 refund = p.collateral - usedCollateral;
            acct.balance += refund;
            acct.lockedInTrades -= refund;
        }

        positionId = nextPositionId++;
        positions[positionId] = Position({
            user: p.user,
            marketId: p.marketId,
            side: p.side,
            shares: shares,
            collateralAtEntry: usedCollateral,
            settled: false
        });

        emit PositionOpened(
            positionId,
            p.user,
            p.marketId,
            p.side,
            usedCollateral,
            shares
        );
    }

    /**
     * Settles a position.
     * Operator must approve this contract for `payout` of collateralToken.
     * Pulls payout from operator → fee on profit to feeRecipient →
     * netPayout credited to user's idle vault balance (withdraw anytime).
     */
    function settlePosition(
        uint256 positionId,
        uint256 payout
    ) external onlyOperator nonReentrant {
        Position storage pos = positions[positionId];
        require(pos.user != address(0), "CopyVault: position does not exist");
        require(!pos.settled, "CopyVault: already settled");
        pos.settled = true;

        UserAccount storage acct = accounts[pos.user];
        acct.lockedInTrades -= pos.collateralAtEntry;

        // Fund settlement: pull full payout from operator into the vault
        if (payout > 0) {
            collateralToken.safeTransferFrom(msg.sender, address(this), payout);
        }

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

    // ── Owner-only ──────────────────────────────────────────────────

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

    function getAccount(
        address user
    )
        external
        view
        returns (
            uint256 balance,
            uint256 lockedInTrades,
            bool copyEnabled,
            uint256 tradeSize
        )
    {
        UserAccount storage acct = accounts[user];
        return (acct.balance, acct.lockedInTrades, acct.copyEnabled, acct.tradeSize);
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    // ── Internal ────────────────────────────────────────────────────

    /**
     * Places the binary order and measures net collateral spent via balance delta.
     * shares = quantityRaw (full-fill assumption).
     *
     * kind: 0 BUY_YES, 2 BUY_NO
     * orderType 2 must match the exchange (same as observed testnet tx).
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
    ) internal returns (uint256 shares, uint256 usedCollateral) {
        uint8 kind = side == Side.Yes ? 0 : 2;

        address market = IBinaryPool(pool).market();
        address token = IBinaryMarket(market).collateral();
        require(token == address(collateralToken), "CopyVault: market collateral mismatch");

        uint256 required = (priceRaw * quantityRaw) / (10 ** collateralDecimals);
        require(required <= collateral, "CopyVault: price*quantity exceeds committed collateral");

        collateralToken.forceApprove(pool, required);

        uint256 colBefore = collateralToken.balanceOf(address(this));

        (bool success, ) = IBinaryPool(pool).placeBinaryOrder(
            kind,
            priceRaw,
            quantityRaw,
            expireTimestampNs,
            2,          // orderType
            0,          // selfMatchingOption
            address(0), // builder
            0,          // builderFeeBpsTimes1k
            0           // userData
        );
        require(success, "CopyVault: placeBinaryOrder rejected");

        uint256 colAfter = collateralToken.balanceOf(address(this));
        require(colBefore >= colAfter, "CopyVault: unexpected collateral increase");
        usedCollateral = colBefore - colAfter;
        require(usedCollateral > 0, "CopyVault: zero fill (no collateral spent)");
        require(usedCollateral <= collateral, "CopyVault: spent more than committed");

        collateralToken.forceApprove(pool, 0);

        shares = quantityRaw;
    }
}