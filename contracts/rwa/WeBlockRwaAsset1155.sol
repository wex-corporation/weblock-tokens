// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IWeBlockRwaTransferHook {
    function beforeBalanceChange(
        address from,
        address to,
        uint256 productId,
        uint256 fromBalanceBefore,
        uint256 toBalanceBefore
    ) external;
}

contract WeBlockRwaAsset1155 is ERC1155Supply, AccessControl, Pausable {
    bytes32 public constant PRODUCT_MANAGER_ROLE = keccak256("PRODUCT_MANAGER_ROLE");
    bytes32 public constant SALE_ROLE = keccak256("SALE_ROLE");
    bytes32 public constant REFUND_ROLE = keccak256("REFUND_ROLE");
    bytes32 public constant REDEMPTION_ROLE = keccak256("REDEMPTION_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct ProductConfig {
        string name;
        string symbol;
        string metadataUri;
        uint256 maxSupply;
        bool exists;
        bool transfersEnabled;
    }

    mapping(uint256 => ProductConfig) private _products;

    address public transferHook;

    event ProductConfigured(
        uint256 indexed productId,
        string name,
        string symbol,
        string metadataUri,
        uint256 maxSupply,
        bool transfersEnabled
    );
    event ProductTransferabilityUpdated(uint256 indexed productId, bool transfersEnabled);
    event TransferHookUpdated(address indexed transferHook);
    event MintedFromSale(uint256 indexed productId, address indexed to, uint256 amount);
    event BurnedFromRefund(uint256 indexed productId, address indexed account, uint256 amount);
    event BurnedFromRedemption(uint256 indexed productId, address indexed account, uint256 amount);

    error InvalidAddress();
    error ProductNotFound(uint256 productId);
    error MaxSupplyExceeded(uint256 productId, uint256 maxSupply, uint256 attemptedSupply);
    error TransfersDisabled(uint256 productId);
    error NotTransferAdmin();

    constructor(address admin) ERC1155("") {
        if (admin == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRODUCT_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setTransferHook(address hook_) external onlyRole(PRODUCT_MANAGER_ROLE) {
        transferHook = hook_;
        emit TransferHookUpdated(hook_);
    }

    function configureProduct(
        uint256 productId,
        string calldata name_,
        string calldata symbol_,
        string calldata metadataUri_,
        uint256 maxSupply_,
        bool transfersEnabled_
    ) external onlyRole(PRODUCT_MANAGER_ROLE) {
        if (maxSupply_ == 0) revert MaxSupplyExceeded(productId, 0, 0);
        if (_products[productId].exists && maxSupply_ < totalSupply(productId)) {
            revert MaxSupplyExceeded(productId, maxSupply_, totalSupply(productId));
        }

        _products[productId] = ProductConfig({
            name: name_,
            symbol: symbol_,
            metadataUri: metadataUri_,
            maxSupply: maxSupply_,
            exists: true,
            transfersEnabled: transfersEnabled_
        });

        emit ProductConfigured(productId, name_, symbol_, metadataUri_, maxSupply_, transfersEnabled_);
    }

    function setTransfersEnabled(uint256 productId, bool transfersEnabled_) external {
        if (!hasRole(PRODUCT_MANAGER_ROLE, msg.sender) && !hasRole(SALE_ROLE, msg.sender)) {
            revert NotTransferAdmin();
        }
        ProductConfig storage product = _products[productId];
        if (!product.exists) revert ProductNotFound(productId);

        product.transfersEnabled = transfersEnabled_;
        emit ProductTransferabilityUpdated(productId, transfersEnabled_);
    }

    function mintFromSale(address to, uint256 productId, uint256 amount) external onlyRole(SALE_ROLE) whenNotPaused {
        ProductConfig memory product = _requireProduct(productId);
        uint256 nextSupply = totalSupply(productId) + amount;
        if (nextSupply > product.maxSupply) {
            revert MaxSupplyExceeded(productId, product.maxSupply, nextSupply);
        }

        _mint(to, productId, amount, "");
        emit MintedFromSale(productId, to, amount);
    }

    function burnFromRefund(address account, uint256 productId, uint256 amount)
        external
        onlyRole(REFUND_ROLE)
        whenNotPaused
    {
        _requireProduct(productId);
        _burn(account, productId, amount);
        emit BurnedFromRefund(productId, account, amount);
    }

    function burnFromRedemption(address account, uint256 productId, uint256 amount)
        external
        onlyRole(REDEMPTION_ROLE)
        whenNotPaused
    {
        _requireProduct(productId);
        _burn(account, productId, amount);
        emit BurnedFromRedemption(productId, account, amount);
    }

    function getProduct(uint256 productId)
        external
        view
        returns (
            string memory name_,
            string memory symbol_,
            string memory metadataUri_,
            uint256 maxSupply_,
            bool transfersEnabled_,
            uint256 currentSupply_
        )
    {
        ProductConfig memory product = _requireProduct(productId);
        return (
            product.name,
            product.symbol,
            product.metadataUri,
            product.maxSupply,
            product.transfersEnabled,
            totalSupply(productId)
        );
    }

    function uri(uint256 productId) public view override returns (string memory) {
        ProductConfig memory product = _requireProduct(productId);
        return product.metadataUri;
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155Supply)
        whenNotPaused
    {
        for (uint256 i = 0; i < ids.length; i++) {
            ProductConfig memory product = _requireProduct(ids[i]);
            if (from != address(0) && to != address(0) && !product.transfersEnabled) {
                revert TransfersDisabled(ids[i]);
            }

            if (transferHook != address(0)) {
                uint256 fromBalanceBefore = from == address(0) ? 0 : balanceOf(from, ids[i]);
                uint256 toBalanceBefore = to == address(0) ? 0 : balanceOf(to, ids[i]);
                IWeBlockRwaTransferHook(transferHook).beforeBalanceChange(
                    from,
                    to,
                    ids[i],
                    fromBalanceBefore,
                    toBalanceBefore
                );
            }
        }

        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _requireProduct(uint256 productId) internal view returns (ProductConfig memory product) {
        product = _products[productId];
        if (!product.exists) revert ProductNotFound(productId);
    }
}
