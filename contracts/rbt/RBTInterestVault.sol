// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC1155Like {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/**
 * RBTInterestVault
 * - Accrues interest per-second based on RBT(ERC1155) balance (tokenId = seriesId).
 * - Pays interest in a reward token (USDT for testnet) via transfer (NOT mint).
 * - Uses `rateMultiplier` to accelerate accrual on testnet.
 *
 * Notes
 * - This vault is designed for a single RBTPropertyToken (one asset clone).
 * - The asset should call `accrueFromAsset(account, tokenId, balanceBefore)` before balance changes
 *   so checkpoints remain accurate across transfers/mints/burns.
 */
contract RBTInterestVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR_SECONDS = 365 days;

    // Target RBT(ERC1155) asset (clone)
    address public immutable asset;

    // Reward token (USDT on testnet)
    IERC20Metadata public immutable rewardToken;

    // rewardDecimals is read from token contract
    uint8 public immutable rewardDecimals;

    // Divider to convert 18-decimal USD-wei to reward token smallest units
    // scaleDivisor = 10^(18 - rewardDecimals)
    uint256 public immutable scaleDivisor;

    // APR in bps (default: 10% = 1000)
    uint256 public aprBps;

    // Testnet acceleration: elapsedSeconds * rateMultiplier
    uint256 public rateMultiplier;

    // Unit price per RBT unit in 18-decimal USD-wei (recommended)
    mapping(uint256 => uint256) public unitPriceWeiByTokenId;
    mapping(uint256 => bool) public seriesEnabled;

    // Accrued interest per user in reward token smallest units
    mapping(uint256 => mapping(address => uint256)) public accrued;

    // Last checkpoint timestamp
    mapping(uint256 => mapping(address => uint64)) public lastAccruedAt;

    event SeriesConfigured(uint256 indexed tokenId, uint256 unitPriceWei, bool enabled);
    event AprUpdated(uint256 aprBps);
    event RateMultiplierUpdated(uint256 rateMultiplier);
    event Accrued(address indexed account, uint256 indexed tokenId, uint256 added, uint64 fromTs, uint64 toTs);
    event Funded(address indexed from, uint256 amount);
    event Claimed(address indexed account, uint256 indexed tokenId, uint256 amount);

    error NotAsset();
    error SeriesNotEnabled();
    error InvalidConfig();

    constructor(address asset_, address rewardToken_, address admin) {
        require(asset_ != address(0) && rewardToken_ != address(0) && admin != address(0), "zero addr");
        asset = asset_;
        rewardToken = IERC20Metadata(rewardToken_);

        uint8 d = rewardToken.decimals();
        require(d <= 18, "reward decimals > 18");
        rewardDecimals = d;

        // 10^(18 - d)
        uint256 div = 1;
        for (uint256 i = 0; i < 18 - uint256(d); i++) {
            div *= 10;
        }
        scaleDivisor = div;

        aprBps = 1000;
        rateMultiplier = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    function pause() external onlyRole(OPERATOR_ROLE) { _pause(); }
    function unpause() external onlyRole(OPERATOR_ROLE) { _unpause(); }

    function setAprBps(uint256 newAprBps) external onlyRole(OPERATOR_ROLE) {
        require(newAprBps <= 10_000, "apr too high");
        aprBps = newAprBps;
        emit AprUpdated(newAprBps);
    }

    function setRateMultiplier(uint256 m) external onlyRole(OPERATOR_ROLE) {
        require(m >= 1 && m <= 1_000_000_000, "bad multiplier");
        rateMultiplier = m;
        emit RateMultiplierUpdated(m);
    }

    function configureSeries(uint256 tokenId, uint256 unitPriceWei, bool enabled)
        external
        onlyRole(OPERATOR_ROLE)
    {
        if (unitPriceWei == 0) revert InvalidConfig();
        unitPriceWeiByTokenId[tokenId] = unitPriceWei;
        seriesEnabled[tokenId] = enabled;
        emit SeriesConfigured(tokenId, unitPriceWei, enabled);
    }

    /**
     * Operator funds the vault with reward tokens for future claims.
     */
    function fund(uint256 amount) external onlyRole(OPERATOR_ROLE) {
        require(amount > 0, "amount=0");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /**
     * View: claimable (accrued + live)
     */
    function claimable(uint256 tokenId, address account) external view returns (uint256) {
        uint256 live = _liveEarned(tokenId, account, IERC1155Like(asset).balanceOf(account, tokenId));
        return accrued[tokenId][account] + live;
    }

    /**
     * Called by RBTPropertyToken before balance changes (uses balanceBefore).
     */
    function accrueFromAsset(address account, uint256 tokenId, uint256 balanceBefore) external whenNotPaused {
        if (msg.sender != asset) revert NotAsset();
        _accrue(tokenId, account, balanceBefore);
    }

    /**
     * User-triggered accrue using current balance.
     */
    function accrue(uint256 tokenId) external whenNotPaused {
        uint256 bal = IERC1155Like(asset).balanceOf(msg.sender, tokenId);
        _accrue(tokenId, msg.sender, bal);
    }

    function claim(uint256 tokenId) external nonReentrant whenNotPaused {
        if (!seriesEnabled[tokenId]) revert SeriesNotEnabled();

        uint256 bal = IERC1155Like(asset).balanceOf(msg.sender, tokenId);
        _accrue(tokenId, msg.sender, bal);

        uint256 amt = accrued[tokenId][msg.sender];
        require(amt > 0, "nothing to claim");
        accrued[tokenId][msg.sender] = 0;

        rewardToken.safeTransfer(msg.sender, amt);
        emit Claimed(msg.sender, tokenId, amt);
    }

    // -------------------------
    // Internal
    // -------------------------

    function _accrue(uint256 tokenId, address account, uint256 balanceBefore) internal {
        if (account == address(0)) return;

        if (!seriesEnabled[tokenId]) {
            // If disabled, set a baseline timestamp to avoid a sudden catch-up later.
            if (lastAccruedAt[tokenId][account] == 0) {
                lastAccruedAt[tokenId][account] = uint64(block.timestamp);
            }
            return;
        }

        uint64 last = lastAccruedAt[tokenId][account];
        uint64 nowTs = uint64(block.timestamp);
        if (last == 0) {
            lastAccruedAt[tokenId][account] = nowTs;
            return;
        }
        if (nowTs <= last) return;

        uint256 added = _earnedFor(tokenId, balanceBefore, uint256(nowTs - last));
        if (added > 0) {
            accrued[tokenId][account] += added;
            emit Accrued(account, tokenId, added, last, nowTs);
        }
        lastAccruedAt[tokenId][account] = nowTs;
    }

    function _liveEarned(uint256 tokenId, address account, uint256 currentBalance) internal view returns (uint256) {
        if (!seriesEnabled[tokenId]) return 0;
        uint64 last = lastAccruedAt[tokenId][account];
        if (last == 0) return 0;
        uint256 elapsed = block.timestamp - uint256(last);
        return _earnedFor(tokenId, currentBalance, elapsed);
    }

    function _earnedFor(uint256 tokenId, uint256 balanceUnits, uint256 elapsedSeconds) internal view returns (uint256) {
        if (balanceUnits == 0 || elapsedSeconds == 0) return 0;

        uint256 unitPriceWei = unitPriceWeiByTokenId[tokenId];
        if (unitPriceWei == 0) return 0;

        // principal value in 18-decimal USD-wei: units * unitPrice
        uint256 principalUsdWei = balanceUnits * unitPriceWei;
        uint256 accElapsed = elapsedSeconds * rateMultiplier;

        // interest in 18-decimal USD-wei
        uint256 interestUsdWei = (principalUsdWei * aprBps * accElapsed) / (BPS * YEAR_SECONDS);

        // convert to reward token smallest units
        return interestUsdWei / scaleDivisor;
    }
}
