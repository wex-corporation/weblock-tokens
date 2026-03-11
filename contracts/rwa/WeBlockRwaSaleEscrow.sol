// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWeBlockRwaAssetSale {
    function mintFromSale(address to, uint256 productId, uint256 amount) external;
    function burnFromRefund(address account, uint256 productId, uint256 amount) external;
    function setTransfersEnabled(uint256 productId, bool transfersEnabled) external;
}

contract WeBlockRwaSaleEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SALE_MANAGER_ROLE = keccak256("SALE_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 public constant STATUS_DRAFT = 0;
    uint8 public constant STATUS_LIVE = 1;
    uint8 public constant STATUS_SOLD_OUT = 2;
    uint8 public constant STATUS_FAILED = 3;
    uint8 public constant STATUS_CANCELLED = 4;

    uint256 public constant MAX_PAYMENT_TOKENS = 4;

    struct Offering {
        uint256 productId;
        uint256 targetUnits;
        uint256 unitsSold;
        uint64 saleStart;
        uint64 saleEnd;
        address treasury;
        uint8 status;
    }

    struct PaymentOption {
        bool enabled;
        bool known;
        uint256 unitPrice;
        uint256 escrowedAmount;
        uint256 releasedAmount;
    }

    IWeBlockRwaAssetSale public immutable asset;

    mapping(uint256 => Offering) public offerings;
    mapping(uint256 => address[]) private paymentTokens;
    mapping(uint256 => mapping(address => PaymentOption)) public paymentOptions;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public contributions;
    mapping(uint256 => mapping(address => uint256)) public purchasedUnits;

    event OfferingConfigured(
        uint256 indexed productId,
        uint256 targetUnits,
        uint64 saleStart,
        uint64 saleEnd,
        address treasury,
        uint8 status
    );
    event PaymentTokenConfigured(uint256 indexed productId, address indexed token, uint256 unitPrice, bool enabled);
    event Purchased(
        uint256 indexed productId,
        address indexed buyer,
        address indexed paymentToken,
        uint256 units,
        uint256 cost,
        uint256 unitsSold,
        uint256 targetUnits
    );
    event SaleFinalized(uint256 indexed productId, address indexed treasury, uint256 unitsSold);
    event SaleFailed(uint256 indexed productId, uint8 status);
    event RefundClaimed(uint256 indexed productId, address indexed buyer, uint256 unitsBurned);

    error InvalidAddress();
    error InvalidValue();
    error InvalidStatus(uint8 status);
    error OfferingNotLive(uint256 productId, uint8 status);
    error OutsideSaleWindow(uint256 productId);
    error UnsupportedPaymentToken(uint256 productId, address paymentToken);
    error MaxPaymentTokensExceeded(uint256 productId);
    error InsufficientRemaining(uint256 productId, uint256 requested, uint256 remaining);
    error CostExceeded(uint256 cost, uint256 maxCost);
    error RefundNotAvailable(uint256 productId, uint8 status);
    error NothingToRefund(uint256 productId, address buyer);

    constructor(address admin, address asset_) {
        if (admin == address(0) || asset_ == address(0)) revert InvalidAddress();

        asset = IWeBlockRwaAssetSale(asset_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SALE_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function configureOffering(
        uint256 productId,
        uint256 targetUnits,
        uint64 saleStart,
        uint64 saleEnd,
        address treasury,
        uint8 status
    ) external onlyRole(SALE_MANAGER_ROLE) {
        if (targetUnits == 0) revert InvalidValue();
        if (treasury == address(0)) revert InvalidAddress();
        if (saleEnd != 0 && saleEnd < saleStart) revert InvalidValue();
        if (status > STATUS_CANCELLED) revert InvalidStatus(status);

        offerings[productId] = Offering({
            productId: productId,
            targetUnits: targetUnits,
            unitsSold: offerings[productId].unitsSold,
            saleStart: saleStart,
            saleEnd: saleEnd,
            treasury: treasury,
            status: status
        });

        emit OfferingConfigured(productId, targetUnits, saleStart, saleEnd, treasury, status);
    }

    function configurePaymentToken(uint256 productId, address token, uint256 unitPrice, bool enabled)
        external
        onlyRole(SALE_MANAGER_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        if (unitPrice == 0) revert InvalidValue();

        PaymentOption storage option = paymentOptions[productId][token];
        if (!option.known) {
            if (paymentTokens[productId].length >= MAX_PAYMENT_TOKENS) {
                revert MaxPaymentTokensExceeded(productId);
            }
            paymentTokens[productId].push(token);
            option.known = true;
        }

        option.enabled = enabled;
        option.unitPrice = unitPrice;

        emit PaymentTokenConfigured(productId, token, unitPrice, enabled);
    }

    function getPaymentTokens(uint256 productId) external view returns (address[] memory) {
        return paymentTokens[productId];
    }

    function buy(uint256 productId, address paymentToken, uint256 units, uint256 maxCost)
        external
        nonReentrant
        whenNotPaused
    {
        if (units == 0) revert InvalidValue();

        Offering storage offering = offerings[productId];
        if (offering.status != STATUS_LIVE) revert OfferingNotLive(productId, offering.status);

        uint64 nowTs = uint64(block.timestamp);
        if ((offering.saleStart != 0 && nowTs < offering.saleStart) || (offering.saleEnd != 0 && nowTs > offering.saleEnd)) {
            revert OutsideSaleWindow(productId);
        }

        uint256 remaining = offering.targetUnits - offering.unitsSold;
        if (units > remaining) {
            revert InsufficientRemaining(productId, units, remaining);
        }

        PaymentOption storage option = paymentOptions[productId][paymentToken];
        if (!option.enabled || option.unitPrice == 0) {
            revert UnsupportedPaymentToken(productId, paymentToken);
        }

        uint256 cost = units * option.unitPrice;
        if (cost > maxCost) revert CostExceeded(cost, maxCost);

        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), cost);

        option.escrowedAmount += cost;
        contributions[productId][msg.sender][paymentToken] += cost;
        purchasedUnits[productId][msg.sender] += units;
        offering.unitsSold += units;

        asset.mintFromSale(msg.sender, productId, units);

        emit Purchased(
            productId,
            msg.sender,
            paymentToken,
            units,
            cost,
            offering.unitsSold,
            offering.targetUnits
        );

        if (offering.unitsSold == offering.targetUnits) {
            _finalizeSuccessful(productId, offering);
        }
    }

    function markFailed(uint256 productId) external onlyRole(SALE_MANAGER_ROLE) {
        Offering storage offering = offerings[productId];
        if (offering.status == STATUS_SOLD_OUT || offering.status == STATUS_FAILED || offering.status == STATUS_CANCELLED) {
            revert InvalidStatus(offering.status);
        }
        if (offering.saleEnd != 0 && block.timestamp <= offering.saleEnd) {
            revert OutsideSaleWindow(productId);
        }

        offering.status = STATUS_FAILED;
        emit SaleFailed(productId, STATUS_FAILED);
    }

    function cancelOffering(uint256 productId) external onlyRole(SALE_MANAGER_ROLE) {
        Offering storage offering = offerings[productId];
        if (offering.status == STATUS_SOLD_OUT) revert InvalidStatus(offering.status);
        offering.status = STATUS_CANCELLED;
        emit SaleFailed(productId, STATUS_CANCELLED);
    }

    function claimRefund(uint256 productId) external nonReentrant whenNotPaused {
        Offering storage offering = offerings[productId];
        if (offering.status != STATUS_FAILED && offering.status != STATUS_CANCELLED) {
            revert RefundNotAvailable(productId, offering.status);
        }

        uint256 units = purchasedUnits[productId][msg.sender];
        if (units == 0) revert NothingToRefund(productId, msg.sender);

        purchasedUnits[productId][msg.sender] = 0;
        asset.burnFromRefund(msg.sender, productId, units);

        address[] memory tokens = paymentTokens[productId];
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 amount = contributions[productId][msg.sender][token];
            if (amount == 0) continue;

            contributions[productId][msg.sender][token] = 0;
            PaymentOption storage option = paymentOptions[productId][token];
            option.escrowedAmount -= amount;
            IERC20(token).safeTransfer(msg.sender, amount);
        }

        emit RefundClaimed(productId, msg.sender, units);
    }

    function _finalizeSuccessful(uint256 productId, Offering storage offering) internal {
        offering.status = STATUS_SOLD_OUT;
        asset.setTransfersEnabled(productId, true);

        address[] memory tokens = paymentTokens[productId];
        for (uint256 i = 0; i < tokens.length; i++) {
            PaymentOption storage option = paymentOptions[productId][tokens[i]];
            uint256 amount = option.escrowedAmount;
            if (amount == 0) continue;

            option.escrowedAmount = 0;
            option.releasedAmount += amount;
            IERC20(tokens[i]).safeTransfer(offering.treasury, amount);
        }

        emit SaleFinalized(productId, offering.treasury, offering.unitsSold);
    }
}
