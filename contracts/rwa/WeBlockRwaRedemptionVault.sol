// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWeBlockRwaAssetRedemption {
    function burnFromRedemption(address account, uint256 productId, uint256 amount) external;
    function balanceOf(address account, uint256 productId) external view returns (uint256);
}

contract WeBlockRwaRedemptionVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REDEMPTION_MANAGER_ROLE = keccak256("REDEMPTION_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 public constant STATUS_DRAFT = 0;
    uint8 public constant STATUS_LIVE = 1;
    uint8 public constant STATUS_CLOSED = 2;
    uint256 public constant MAX_PAYOUT_TOKENS = 4;

    struct RedemptionConfig {
        uint256 productId;
        uint64 redeemStart;
        uint64 redeemEnd;
        uint8 status;
    }

    struct PayoutOption {
        bool enabled;
        bool known;
        uint256 unitPrice;
        uint256 availableAmount;
        uint256 paidAmount;
    }

    IWeBlockRwaAssetRedemption public immutable asset;

    mapping(uint256 => RedemptionConfig) public redemptions;
    mapping(uint256 => address[]) private payoutTokens;
    mapping(uint256 => mapping(address => PayoutOption)) public payoutOptions;

    event RedemptionConfigured(uint256 indexed productId, uint64 redeemStart, uint64 redeemEnd, uint8 status);
    event PayoutTokenConfigured(uint256 indexed productId, address indexed payoutToken, uint256 unitPrice, bool enabled);
    event Funded(uint256 indexed productId, address indexed payoutToken, uint256 amount, uint256 availableAmount);
    event Redeemed(
        uint256 indexed productId,
        address indexed payoutToken,
        address indexed account,
        uint256 units,
        uint256 payoutAmount
    );

    error InvalidAddress();
    error InvalidAmount();
    error InvalidStatus(uint8 status);
    error RedemptionNotLive(uint256 productId, uint8 status);
    error OutsideRedemptionWindow(uint256 productId);
    error UnsupportedPayoutToken(uint256 productId, address payoutToken);
    error MaxPayoutTokensExceeded(uint256 productId);
    error InsufficientLiquidity(uint256 productId, address payoutToken, uint256 requested, uint256 available);

    constructor(address admin, address asset_) {
        if (admin == address(0) || asset_ == address(0)) revert InvalidAddress();

        asset = IWeBlockRwaAssetRedemption(asset_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REDEMPTION_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function configureRedemption(uint256 productId, uint64 redeemStart, uint64 redeemEnd, uint8 status)
        external
        onlyRole(REDEMPTION_MANAGER_ROLE)
    {
        if (redeemEnd != 0 && redeemEnd < redeemStart) revert InvalidAmount();
        if (status > STATUS_CLOSED) revert InvalidStatus(status);

        redemptions[productId] = RedemptionConfig({
            productId: productId,
            redeemStart: redeemStart,
            redeemEnd: redeemEnd,
            status: status
        });

        emit RedemptionConfigured(productId, redeemStart, redeemEnd, status);
    }

    function configurePayoutToken(uint256 productId, address payoutToken, uint256 unitPrice, bool enabled)
        external
        onlyRole(REDEMPTION_MANAGER_ROLE)
    {
        if (payoutToken == address(0)) revert InvalidAddress();
        if (unitPrice == 0) revert InvalidAmount();

        PayoutOption storage option = payoutOptions[productId][payoutToken];
        if (!option.known) {
            if (payoutTokens[productId].length >= MAX_PAYOUT_TOKENS) {
                revert MaxPayoutTokensExceeded(productId);
            }
            payoutTokens[productId].push(payoutToken);
            option.known = true;
        }

        option.enabled = enabled;
        option.unitPrice = unitPrice;

        emit PayoutTokenConfigured(productId, payoutToken, unitPrice, enabled);
    }

    function getPayoutTokens(uint256 productId) external view returns (address[] memory) {
        return payoutTokens[productId];
    }

    function fund(uint256 productId, address payoutToken, uint256 amount)
        external
        onlyRole(REDEMPTION_MANAGER_ROLE)
        whenNotPaused
    {
        if (!payoutOptions[productId][payoutToken].enabled) {
            revert UnsupportedPayoutToken(productId, payoutToken);
        }
        if (amount == 0) revert InvalidAmount();

        IERC20(payoutToken).safeTransferFrom(msg.sender, address(this), amount);
        payoutOptions[productId][payoutToken].availableAmount += amount;

        emit Funded(
            productId,
            payoutToken,
            amount,
            payoutOptions[productId][payoutToken].availableAmount
        );
    }

    function redeem(uint256 productId, address payoutToken, uint256 units)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 payoutAmount)
    {
        if (units == 0) revert InvalidAmount();

        RedemptionConfig memory config = redemptions[productId];
        if (config.status != STATUS_LIVE) revert RedemptionNotLive(productId, config.status);

        uint64 nowTs = uint64(block.timestamp);
        if ((config.redeemStart != 0 && nowTs < config.redeemStart) || (config.redeemEnd != 0 && nowTs > config.redeemEnd)) {
            revert OutsideRedemptionWindow(productId);
        }

        PayoutOption storage option = payoutOptions[productId][payoutToken];
        if (!option.enabled || option.unitPrice == 0) {
            revert UnsupportedPayoutToken(productId, payoutToken);
        }

        payoutAmount = units * option.unitPrice;
        if (payoutAmount > option.availableAmount) {
            revert InsufficientLiquidity(productId, payoutToken, payoutAmount, option.availableAmount);
        }

        option.availableAmount -= payoutAmount;
        option.paidAmount += payoutAmount;

        asset.burnFromRedemption(msg.sender, productId, units);
        IERC20(payoutToken).safeTransfer(msg.sender, payoutAmount);

        emit Redeemed(productId, payoutToken, msg.sender, units, payoutAmount);
    }

    function previewRedeem(uint256 productId, address payoutToken, address account)
        external
        view
        returns (uint256 units, uint256 payoutAmount)
    {
        units = asset.balanceOf(account, productId);
        payoutAmount = units * payoutOptions[productId][payoutToken].unitPrice;
    }

    function withdrawSurplus(uint256 productId, address payoutToken, address to, uint256 amount)
        external
        onlyRole(REDEMPTION_MANAGER_ROLE)
    {
        if (to == address(0)) revert InvalidAddress();
        if (redemptions[productId].status == STATUS_LIVE) revert RedemptionNotLive(productId, STATUS_LIVE);
        if (amount == 0 || amount > payoutOptions[productId][payoutToken].availableAmount) revert InvalidAmount();

        payoutOptions[productId][payoutToken].availableAmount -= amount;
        IERC20(payoutToken).safeTransfer(to, amount);
    }
}
