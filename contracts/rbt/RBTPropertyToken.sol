// contracts/rbt/RBTPropertyToken.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface IRBTInterestVault {
    /**
     * Accrue interest for `account` on `tokenId` using the balance BEFORE the balance change.
     *
     * NOTE: This function is designed to be called by the RBTPropertyToken during mint/transfer/burn,
     * before the balances are updated, so that interest accounting remains correct when balances change.
     */
    function accrueFromAsset(address account, uint256 tokenId, uint256 balanceBefore) external;
}

/**
 * RBTPropertyToken
 * - 1 Asset = 1 Contract
 * - Series/Tranche = tokenId
 * - KYC whitelist-gated transfer
 * - Revenue distribution (USDR) per tokenId via cumulative-per-share accounting
 */
contract RBTPropertyToken is ERC1155Supply, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant ISSUER_ROLE   = keccak256("ISSUER_ROLE");

    string public assetName;
    string public assetSymbol;
    string public assetLabel;

    IERC20 public settlementToken; // USDR

    // Optional: per-second interest accrual vault (e.g., WFT interest) for testing / incentives.
    // If set, the token will notify the vault on every balance change.
    address public interestVault;

    // Metadata base URI
    string public baseURI;

    mapping(address => bool) public whitelisted;
    mapping(address => bool) public frozen;
    mapping(address => bool) public blacklisted;

    struct Series {
        string label;
        uint256 unitPrice;  // 회계/정산 기준 단가 (예: 1,000,000)
        uint256 maxSupply;
        bool active;
    }

    uint256 public nextSeriesId;
    mapping(uint256 => Series) public series;

    // cumulativeRevenuePerToken[tokenId] scaled by 1e18
    mapping(uint256 => uint256) public cumulativeRevenuePerToken;
    // userRevenueCredited[tokenId][account] scaled by 1e18
    mapping(uint256 => mapping(address => uint256)) public userRevenueCredited;

    // Transfer-safe revenue accounting
    mapping(uint256 => mapping(address => uint256)) public pendingRevenue;

    event WhitelistUpdated(address indexed account, bool allowed);
    event FrozenUpdated(address indexed account, bool frozen);
    event BlacklistUpdated(address indexed account, bool blacklisted);

    event SeriesCreated(uint256 indexed tokenId, string label, uint256 unitPrice, uint256 maxSupply);
    event SeriesStatusChanged(uint256 indexed tokenId, bool active);

    event Issued(uint256 indexed tokenId, address indexed to, uint256 amount);
    event RevenueDeposited(uint256 indexed tokenId, uint256 amount, uint256 newCumulativePerToken);
    event RevenueClaimed(uint256 indexed tokenId, address indexed account, uint256 amount);

    event BaseURIUpdated(string baseURI);
    event InterestVaultUpdated(address indexed interestVault);

    bool private _initialized;

    constructor() ERC1155("") {}

    function initialize(
        string calldata _assetName,
        string calldata _assetSymbol,
        string calldata _assetLabel,
        address _settlementToken,
        address admin
    ) external {
        require(!_initialized, "already initialized");
        _initialized = true;

        assetName = _assetName;
        assetSymbol = _assetSymbol;
        assetLabel = _assetLabel;
        settlementToken = IERC20(_settlementToken);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);

        whitelisted[admin] = true;
        nextSeriesId = 1;
    }

    function setBaseURI(string calldata uri_) external onlyRole(OPERATOR_ROLE) {
        baseURI = uri_;
        emit BaseURIUpdated(uri_);
    }

    function setWhitelist(address account, bool allowed) external onlyRole(OPERATOR_ROLE) {
        whitelisted[account] = allowed;
        emit WhitelistUpdated(account, allowed);
    }

    function setFrozen(address account, bool _frozen) external onlyRole(OPERATOR_ROLE) {
        frozen[account] = _frozen;
        emit FrozenUpdated(account, _frozen);
    }

    function setBlacklisted(address account, bool _blacklisted) external onlyRole(OPERATOR_ROLE) {
        blacklisted[account] = _blacklisted;
        emit BlacklistUpdated(account, _blacklisted);
    }

    function pause() external onlyRole(OPERATOR_ROLE) { _pause(); }
    function unpause() external onlyRole(OPERATOR_ROLE) { _unpause(); }

    function setInterestVault(address vault) external onlyRole(OPERATOR_ROLE) {
        interestVault = vault;
        emit InterestVaultUpdated(vault);
    }

    function createSeries(
        string calldata label,
        uint256 unitPrice,
        uint256 maxSupply
    ) external onlyRole(ISSUER_ROLE) returns (uint256 tokenId) {
        require(maxSupply > 0, "maxSupply=0");
        tokenId = nextSeriesId++;
        series[tokenId] = Series({ label: label, unitPrice: unitPrice, maxSupply: maxSupply, active: true });
        emit SeriesCreated(tokenId, label, unitPrice, maxSupply);
    }

    function setSeriesActive(uint256 tokenId, bool active) external onlyRole(OPERATOR_ROLE) {
        require(bytes(series[tokenId].label).length != 0, "series not found");
        series[tokenId].active = active;
        emit SeriesStatusChanged(tokenId, active);
    }

    function issue(uint256 tokenId, address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        Series memory s = series[tokenId];
        require(bytes(s.label).length != 0, "series not found");
        require(s.active, "series inactive");
        require(totalSupply(tokenId) + amount <= s.maxSupply, "exceeds maxSupply");
        require(_canReceive(to), "receiver not allowed");

        _mint(to, tokenId, amount, "");
        emit Issued(tokenId, to, amount);
    }

    function depositRevenue(uint256 tokenId, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        require(amount > 0, "amount=0");
        require(totalSupply(tokenId) > 0, "no supply");
        require(bytes(series[tokenId].label).length != 0, "series not found");

        require(settlementToken.transferFrom(msg.sender, address(this), amount), "transferFrom failed");

        uint256 inc = (amount * 1e18) / totalSupply(tokenId);
        cumulativeRevenuePerToken[tokenId] += inc;

        emit RevenueDeposited(tokenId, amount, cumulativeRevenuePerToken[tokenId]);
    }

    function claimable(uint256 tokenId, address account) public view returns (uint256) {
        uint256 bal = balanceOf(account, tokenId);
        uint256 cumulative = cumulativeRevenuePerToken[tokenId];
        uint256 credited = userRevenueCredited[tokenId][account];

        uint256 live = 0;
        if (bal > 0 && cumulative > credited) {
            live = (bal * (cumulative - credited)) / 1e18;
        }
        return pendingRevenue[tokenId][account] + live;
    }

    function claim(uint256 tokenId) external nonReentrant whenNotPaused {
        require(_canAct(msg.sender), "sender not allowed");

        uint256 amount = claimable(tokenId, msg.sender);
        require(amount > 0, "nothing to claim");

        pendingRevenue[tokenId][msg.sender] = 0;
        userRevenueCredited[tokenId][msg.sender] = cumulativeRevenuePerToken[tokenId];

        require(settlementToken.transfer(msg.sender, amount), "transfer failed");
        emit RevenueClaimed(tokenId, msg.sender, amount);
    }

    function _accrue(uint256 tokenId, address account) internal {
        if (account == address(0)) return;
        uint256 bal = balanceOf(account, tokenId);
        uint256 cumulative = cumulativeRevenuePerToken[tokenId];
        uint256 credited = userRevenueCredited[tokenId][account];

        if (bal > 0 && cumulative > credited) {
            uint256 delta = cumulative - credited;
            pendingRevenue[tokenId][account] += (bal * delta) / 1e18;
        }
        userRevenueCredited[tokenId][account] = cumulative;
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155Supply) whenNotPaused {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];

            // --- Interest vault checkpoint (balance BEFORE this update) ---
            if (interestVault != address(0)) {
                // Balance before update is visible here.
                if (from != address(0)) {
                    uint256 fromBal = balanceOf(from, tokenId);
                    IRBTInterestVault(interestVault).accrueFromAsset(from, tokenId, fromBal);
                }
                if (to != address(0)) {
                    uint256 toBal = balanceOf(to, tokenId);
                    IRBTInterestVault(interestVault).accrueFromAsset(to, tokenId, toBal);
                }
            }

            if (from != address(0)) _accrue(tokenId, from);
            if (to != address(0)) _accrue(tokenId, to);
        }

        if (from == address(0)) {
            require(_canReceive(to), "receiver not allowed");
            super._update(from, to, ids, values);
            return;
        }

        if (to == address(0)) {
            require(_canAct(from), "sender not allowed");
            super._update(from, to, ids, values);
            return;
        }

        require(_canAct(from), "sender not allowed");
        require(_canReceive(to), "receiver not allowed");
        super._update(from, to, ids, values);
    }

    function _canAct(address a) internal view returns (bool) {
        if (blacklisted[a]) return false;
        if (frozen[a]) return false;
        if (!whitelisted[a]) return false;
        return true;
    }

    function _canReceive(address a) internal view returns (bool) {
        return _canAct(a);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        if (bytes(baseURI).length == 0) return "";
        return string.concat(baseURI, Strings.toString(tokenId));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
