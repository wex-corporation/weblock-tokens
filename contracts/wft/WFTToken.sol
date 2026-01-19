// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract WFTToken is
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // 운영 정책용 메타
    string public termsURI; // 토큰 유틸리티/약관/공시 문서 URI (ipfs/https)

    function initialize(
        address admin,
        string calldata _termsURI
    ) external initializer {
        __ERC20_init("WeBlock Utility Token", "WFT");
        __ERC20Permit_init("WeBlock Utility Token");
        __ERC20Votes_init();
        __AccessControl_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        termsURI = _termsURI;
    }

    function setTermsURI(string calldata _termsURI)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
    {
        termsURI = _termsURI;
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function mint(address to, uint256 amount)
    external
    onlyRole(MINTER_ROLE)
    {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }

    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, _msgSender(), amount);
        _burn(account, amount);
    }

    function _authorizeUpgrade(address)
    internal
    override
    onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    // --- Required overrides (Votes + ERC20) ---
    function _update(address from, address to, uint256 value)
    internal
    override(ERC20Upgradeable, ERC20VotesUpgradeable)
    whenNotPaused
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
    public
    view
    override(ERC20PermitUpgradeable, NoncesUpgradeable)
    returns (uint256)
    {
        return super.nonces(owner);
    }
}
