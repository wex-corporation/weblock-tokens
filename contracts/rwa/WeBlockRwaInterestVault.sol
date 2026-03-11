// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWeBlockRwaAssetBalance {
    function balanceOf(address account, uint256 productId) external view returns (uint256);
    function totalSupply(uint256 productId) external view returns (uint256);
}

contract WeBlockRwaInterestVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_MANAGER_ROLE = keccak256("VAULT_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_REWARD_TOKENS = 4;

    IWeBlockRwaAssetBalance public immutable asset;

    mapping(uint256 => address[]) private rewardTokens;
    mapping(uint256 => mapping(address => bool)) public rewardTokenEnabled;
    mapping(uint256 => mapping(address => bool)) private rewardTokenKnown;
    mapping(uint256 => mapping(address => uint256)) public cumulativeRewardPerShare;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public rewardDebt;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public accrued;

    event RewardTokenConfigured(uint256 indexed productId, address indexed rewardToken, bool enabled);
    event Funded(uint256 indexed productId, address indexed rewardToken, uint256 amount, uint256 cumulativeRewardPerShare);
    event Claimed(uint256 indexed productId, address indexed rewardToken, address indexed account, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error UnsupportedRewardToken(uint256 productId, address rewardToken);
    error MaxRewardTokensExceeded(uint256 productId);

    constructor(address admin, address asset_) {
        if (admin == address(0) || asset_ == address(0)) revert InvalidAddress();

        asset = IWeBlockRwaAssetBalance(asset_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function configureRewardToken(uint256 productId, address rewardToken, bool enabled)
        external
        onlyRole(VAULT_MANAGER_ROLE)
    {
        if (rewardToken == address(0)) revert InvalidAddress();

        if (!rewardTokenKnown[productId][rewardToken]) {
            if (rewardTokens[productId].length >= MAX_REWARD_TOKENS) {
                revert MaxRewardTokensExceeded(productId);
            }
            rewardTokens[productId].push(rewardToken);
            rewardTokenKnown[productId][rewardToken] = true;
        }

        rewardTokenEnabled[productId][rewardToken] = enabled;
        emit RewardTokenConfigured(productId, rewardToken, enabled);
    }

    function getRewardTokens(uint256 productId) external view returns (address[] memory) {
        return rewardTokens[productId];
    }

    function fund(uint256 productId, address rewardToken, uint256 amount)
        external
        onlyRole(VAULT_MANAGER_ROLE)
        whenNotPaused
    {
        if (amount == 0) revert InvalidAmount();
        if (!rewardTokenEnabled[productId][rewardToken]) {
            revert UnsupportedRewardToken(productId, rewardToken);
        }

        uint256 supply = asset.totalSupply(productId);
        if (supply == 0) revert InvalidAmount();

        IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);
        cumulativeRewardPerShare[productId][rewardToken] += (amount * PRECISION) / supply;

        emit Funded(
            productId,
            rewardToken,
            amount,
            cumulativeRewardPerShare[productId][rewardToken]
        );
    }

    function beforeBalanceChange(
        address from,
        address to,
        uint256 productId,
        uint256 fromBalanceBefore,
        uint256 toBalanceBefore
    ) external whenNotPaused {
        if (msg.sender != address(asset)) revert InvalidAddress();

        address[] memory tokens = rewardTokens[productId];
        for (uint256 i = 0; i < tokens.length; i++) {
            address rewardToken = tokens[i];
            if (!rewardTokenEnabled[productId][rewardToken]) continue;

            _accrue(productId, rewardToken, from, fromBalanceBefore);
            _accrue(productId, rewardToken, to, toBalanceBefore);
        }
    }

    function claim(uint256 productId, address rewardToken)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amount)
    {
        if (!rewardTokenEnabled[productId][rewardToken]) {
            revert UnsupportedRewardToken(productId, rewardToken);
        }

        _checkpoint(productId, rewardToken, msg.sender);
        amount = accrued[productId][rewardToken][msg.sender];
        if (amount == 0) revert InvalidAmount();

        accrued[productId][rewardToken][msg.sender] = 0;
        IERC20(rewardToken).safeTransfer(msg.sender, amount);
        emit Claimed(productId, rewardToken, msg.sender, amount);
    }

    function claimAll(uint256 productId) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        address[] memory tokens = rewardTokens[productId];
        amounts = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            address rewardToken = tokens[i];
            if (!rewardTokenEnabled[productId][rewardToken]) continue;

            _checkpoint(productId, rewardToken, msg.sender);
            uint256 amount = accrued[productId][rewardToken][msg.sender];
            if (amount == 0) continue;

            accrued[productId][rewardToken][msg.sender] = 0;
            IERC20(rewardToken).safeTransfer(msg.sender, amount);
            amounts[i] = amount;
            emit Claimed(productId, rewardToken, msg.sender, amount);
        }
    }

    function claimable(uint256 productId, address rewardToken, address account) external view returns (uint256) {
        uint256 debt = rewardDebt[productId][rewardToken][account];
        uint256 cumulative = cumulativeRewardPerShare[productId][rewardToken];
        uint256 live = 0;
        if (cumulative > debt) {
            uint256 balance = asset.balanceOf(account, productId);
            live = (balance * (cumulative - debt)) / PRECISION;
        }

        return accrued[productId][rewardToken][account] + live;
    }

    function _checkpoint(uint256 productId, address rewardToken, address account) internal {
        uint256 balance = asset.balanceOf(account, productId);
        _accrue(productId, rewardToken, account, balance);
    }

    function _accrue(uint256 productId, address rewardToken, address account, uint256 balanceBefore) internal {
        if (account == address(0)) return;

        uint256 cumulative = cumulativeRewardPerShare[productId][rewardToken];
        uint256 debt = rewardDebt[productId][rewardToken][account];
        if (cumulative > debt && balanceBefore > 0) {
            accrued[productId][rewardToken][account] += (balanceBefore * (cumulative - debt)) / PRECISION;
        }
        rewardDebt[productId][rewardToken][account] = cumulative;
    }
}
