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
  * Fill accounting:
 *   - After placeBinaryOrder, net collateral spent is measured via balance
 *     delta (handles better fill price + exchange refunds).
 *   - Unspent collateral is refunded to the user's idle balance.
 *   - shares = quantityRaw (full-fill assumption).
 * Settlement funding:
 *   1) Operator calls redeemMarket(marketId, winningSide) once after resolution
 *      → redeemNative on the collateral router → collateral into marketPot.
 *   2) settlePosition spends marketPot first; operator wallet only covers shortfall.
 *   3) Fee on profit only; netPayout → user idle balance for withdraw.
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

interface ICollateralRouter {
    // Return type intentionally unmodeled — we measure the balance delta
    // instead of trusting a decoded return value we haven't verified.
    function redeemNative(
        uint32 operatorId,
        bytes32 venueId,
        bytes32 marketId,
        uint8 outcomeIdx,
        uint256 amount
    ) external;
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

    // DreamDEX venue identifiers (same as bot config) — fixed at deploy
    address public immutable collateralRouter;
    bytes32 public immutable venueId;
    uint32 public immutable operatorId;

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

    // Aggregate shares per (marketId, side) — incremented on open
    mapping(bytes32 => mapping(uint8 => uint256)) public marketSideShares;
    // Collateral recovered by redeemMarket; spent by settlePosition
    mapping(bytes32 => uint256) public marketPot;
    mapping(bytes32 => bool) public marketRedeemed;

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
    event MarketRedeemed(
        bytes32 indexed marketId,
        uint8 indexed side,
        uint256 amountRedeemed,
        uint256 collateralRecovered
    );

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyOperator() {
        require(msg.sender == operator, "CopyVault: not operator");
        _;
    }

    constructor(
        address _collateralToken,
        address _operator,
        address _feeRecipient,
        uint256 _feeBps,
        address _collateralRouter,
        bytes32 _venueId,
        uint32 _operatorId
    ) Ownable(msg.sender) {
        require(_collateralToken != address(0), "CopyVault: zero collateral token");
        require(_operator != address(0), "CopyVault: zero operator");
        require(_feeRecipient != address(0), "CopyVault: zero fee recipient");
        require(_feeBps <= MAX_FEE_BPS, "CopyVault: fee exceeds cap");
        require(_collateralRouter != address(0), "CopyVault: zero collateral router");

        collateralToken = IERC20(_collateralToken);
        collateralDecimals = IERC20Metadata(_collateralToken).decimals();
        operator = _operator;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        collateralRouter = _collateralRouter;
        venueId = _venueId;
        operatorId = _operatorId;
    }

    // ── User-facing ─────────────────────────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "CopyVault: zero amount");
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        accounts[msg.sender].balance += amount;
        emit Deposited(msg.sender, amount);
    }

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

        marketSideShares[p.marketId][uint8(p.side)] += shares;

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
     * Redeem vault-held outcome for one market+side once after resolution.
     * Collateral recovered goes to marketPot[marketId].
     * Call BEFORE settling positions on that market when possible.
     * If skipped/fails, settlePosition still works via operator wallet.
     */
    function redeemMarket(
        bytes32 marketId,
        uint8 side
    ) external onlyOperator nonReentrant {
        require(!marketRedeemed[marketId], "CopyVault: already redeemed");
        uint256 amount = marketSideShares[marketId][side];
        require(amount > 0, "CopyVault: nothing to redeem for this market/side");
        marketRedeemed[marketId] = true;

        uint256 beforeBal = collateralToken.balanceOf(address(this));

        ICollateralRouter(collateralRouter).redeemNative(
            operatorId,
            venueId,
            marketId,
            side,
            amount
        );

        uint256 afterBal = collateralToken.balanceOf(address(this));
        require(afterBal >= beforeBal, "CopyVault: unexpected collateral decrease on redeem");
        uint256 recovered = afterBal - beforeBal;

        marketPot[marketId] += recovered;
        emit MarketRedeemed(marketId, side, amount, recovered);
    }

    /**
     * Settles a position. Spends marketPot first; operator covers shortfall.
     * Fee on profit only; net → user idle balance.
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

        if (payout > 0) {
            uint256 pot = marketPot[pos.marketId];
            if (pot >= payout) {
                marketPot[pos.marketId] = pot - payout;
            } else {
                uint256 shortfall = payout - pot;
                marketPot[pos.marketId] = 0;
                collateralToken.safeTransferFrom(msg.sender, address(this), shortfall);
            }
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
        {
            address market = IBinaryPool(pool).market();
            require(
                IBinaryMarket(market).collateral() == address(collateralToken),
                "CopyVault: market collateral mismatch"
            );
        }

        {
            uint256 required = (priceRaw * quantityRaw) / (10 ** collateralDecimals);
            require(required <= collateral, "CopyVault: price*quantity exceeds committed collateral");
            collateralToken.forceApprove(pool, required);
        }

        usedCollateral = collateralToken.balanceOf(address(this));

        {
            uint8 kind = side == Side.Yes ? 0 : 2;
            (bool success, ) = IBinaryPool(pool).placeBinaryOrder(
                kind,
                priceRaw,
                quantityRaw,
                expireTimestampNs,
                2,
                0,
                address(0),
                0,
                0
            );
            require(success, "CopyVault: placeBinaryOrder rejected");
        }

        usedCollateral = usedCollateral - collateralToken.balanceOf(address(this));
        require(usedCollateral > 0, "CopyVault: zero fill (no collateral spent)");
        require(usedCollateral <= collateral, "CopyVault: spent more than committed");

        collateralToken.forceApprove(pool, 0);
        shares = quantityRaw;
    }
}