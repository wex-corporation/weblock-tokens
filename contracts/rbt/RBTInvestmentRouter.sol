// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IRBTPropertyTokenIssue {
    function issue(uint256 tokenId, address to, uint256 amount) external;
}

/**
 * RBTInvestmentRouter
 * - 투자자가 USDR 또는 USDT로 RBT(ERC1155)를 구매할 수 있도록 하는 단순 라우터
 * - KYC/whitelist 등 투자자 필터링은 MVP 단계에서 제거
 * - 결제 토큰은 Offering 단위로 지정
 */
contract RBTInvestmentRouter is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SALE_MANAGER_ROLE = keccak256("SALE_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Offering {
        address asset;          // RBTPropertyToken(clone) address
        uint256 seriesId;       // tokenId
        address paymentToken;   // USDR or USDT
        uint256 unitPrice;      // price per unit in paymentToken wei
        uint256 remainingUnits; // 0 means unlimited
        uint64 startAt;         // 0 means now
        uint64 endAt;           // 0 means no end
        address treasury;       // paymentToken receiver
        bool enabled;
    }

    mapping(uint256 => Offering) public offerings;

    event OfferingUpserted(
        uint256 indexed offeringId,
        address indexed asset,
        uint256 indexed seriesId,
        address paymentToken,
        uint256 unitPrice,
        uint256 remainingUnits,
        uint64 startAt,
        uint64 endAt,
        address treasury,
        bool enabled
    );

    event Purchased(
        uint256 indexed offeringId,
        address indexed buyer,
        address indexed asset,
        uint256 seriesId,
        address paymentToken,
        uint256 units,
        uint256 cost,
        address treasury
    );

    error InvalidAddress();
    error InvalidPrice();
    error NotEnabled();
    error NotInSaleTime();
    error InvalidUnits();
    error InsufficientRemaining();
    error CostExceeded(uint256 cost, uint256 maxCost);

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SALE_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function upsertOffering(
        uint256 offeringId,
        address asset,
        uint256 seriesId,
        address paymentToken,
        uint256 unitPrice,
        uint256 remainingUnits,
        uint64 startAt,
        uint64 endAt,
        address treasury,
        bool enabled
    ) external onlyRole(SALE_MANAGER_ROLE) {
        if (asset == address(0) || paymentToken == address(0) || treasury == address(0)) {
            revert InvalidAddress();
        }
        if (unitPrice == 0) revert InvalidPrice();
        if (endAt != 0 && endAt < startAt) revert NotInSaleTime();

        offerings[offeringId] = Offering({
            asset: asset,
            seriesId: seriesId,
            paymentToken: paymentToken,
            unitPrice: unitPrice,
            remainingUnits: remainingUnits,
            startAt: startAt,
            endAt: endAt,
            treasury: treasury,
            enabled: enabled
        });

        emit OfferingUpserted(
            offeringId, asset, seriesId, paymentToken, unitPrice, remainingUnits, startAt, endAt, treasury, enabled
        );
    }

    function buy(uint256 offeringId, uint256 units, uint256 maxCost)
    external
    nonReentrant
    whenNotPaused
    {
        if (units == 0) revert InvalidUnits();

        Offering storage off = offerings[offeringId];
        if (!off.enabled) revert NotEnabled();

        uint64 nowTs = uint64(block.timestamp);
        if (off.startAt != 0 && nowTs < off.startAt) revert NotInSaleTime();
        if (off.endAt != 0 && nowTs > off.endAt) revert NotInSaleTime();

        if (off.remainingUnits != 0) {
            if (off.remainingUnits < units) revert InsufficientRemaining();
            off.remainingUnits -= units;
        }

        uint256 cost = units * off.unitPrice;
        if (cost > maxCost) revert CostExceeded(cost, maxCost);

        // 1) paymentToken 결제 -> treasury
        IERC20(off.paymentToken).safeTransferFrom(msg.sender, off.treasury, cost);

        // 2) RBT 지급 (issue 호출)
        IRBTPropertyTokenIssue(off.asset).issue(off.seriesId, msg.sender, units);

        emit Purchased(
            offeringId, msg.sender, off.asset, off.seriesId, off.paymentToken, units, cost, off.treasury
        );
    }

    function rescueERC20(address token, address to, uint256 amount)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
