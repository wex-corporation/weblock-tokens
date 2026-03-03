// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * USDT (Test)
 * - 단순 ERC20 모의 토큰
 * - 실제 USDT와 유사하게 decimals=6
 * - 개발/테스트 편의를 위해 MINTER_ROLE로 추가 발행 가능
 */
contract USDT is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address admin
    ) ERC20(name_, symbol_) {
        require(admin != address(0), "admin=0");
        _decimals = 6;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);

        if (initialSupply > 0) {
            _mint(admin, initialSupply);
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
