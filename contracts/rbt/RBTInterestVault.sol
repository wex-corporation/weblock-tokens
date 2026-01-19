// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC1155Like {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

interface IWFTMinter {
    function mint(address to, uint256 amount) external;
}

/**
 * RBTInterestVault
 * - RBT(ERC1155) 보유량(Series tokenId 기준)을 원금으로 보고, 연이율(APR) 기반 이자를 초 단위로 누적
 * - claim 시 WFT를 mint 하여 유저에게 지급
 * - 테스트넷에서 빠른 검증을 위해 `rateMultiplier`를 통해 시간 가속 가능
 *
 * 설계 메모
 * - 이 vault는 1개의 RBTPropertyToken(= 1 asset contract)을 대상으로 동작한다.
 * - RBTPropertyToken은 transfer/mint/burn 직전에 `accrueFromAsset(account, tokenId, balanceBefore)`를 호출하여
 *   잔고 변동이 있어도 누적 이자가 정확히 유지되도록 체크포인트를 남긴다.
 * - 운영 환경에서는 rateMultiplier=1로 고정하는 것을 권장한다.
 */
contract RBTInterestVault is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR_SECONDS = 365 days;

    // 대상 RBT(ERC1155) 자산 컨트랙트
    address public immutable asset;

    // 지급 토큰 (WFT) - mint 권한 필요
    IWFTMinter public immutable wft;

    // 기본 APR (bps). 기본값: 10% = 1000 bps
    uint256 public aprBps;

    // 테스트넷 가속: elapsedSeconds * rateMultiplier
    uint256 public rateMultiplier;

    // tokenId(=seriesId) 별 원금 환산 단가 (wei, 18 decimals)
    // 예) offering unitPriceWei = 1e18 이면 1 RBT unit == 1 USDR(==1 WFT) 기준
    mapping(uint256 => uint256) public unitPriceWeiByTokenId;
    mapping(uint256 => bool) public seriesEnabled;

    // 누적 정산: accrued[tokenId][account] (WFT wei)
    mapping(uint256 => mapping(address => uint256)) public accrued;

    // 마지막 체크포인트 시간
    mapping(uint256 => mapping(address => uint64)) public lastAccruedAt;

    event SeriesConfigured(uint256 indexed tokenId, uint256 unitPriceWei, bool enabled);
    event AprUpdated(uint256 aprBps);
    event RateMultiplierUpdated(uint256 rateMultiplier);
    event Accrued(address indexed account, uint256 indexed tokenId, uint256 added, uint64 fromTs, uint64 toTs);
    event Claimed(address indexed account, uint256 indexed tokenId, uint256 amount);

    error NotAsset();
    error SeriesNotEnabled();
    error InvalidConfig();

    constructor(address asset_, address wft_, address admin) {
        require(asset_ != address(0) && wft_ != address(0) && admin != address(0), "zero addr");
        asset = asset_;
        wft = IWFTMinter(wft_);

        aprBps = 1000; // 10%
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

    /**
     * 테스트넷 가속용. 운영에서는 1로 고정 권장.
     */
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
     * View: 지금 시점 기준 claimable (accrued + live)
     */
    function claimable(uint256 tokenId, address account) external view returns (uint256) {
        uint256 live = _liveEarned(tokenId, account, IERC1155Like(asset).balanceOf(account, tokenId));
        return accrued[tokenId][account] + live;
    }

    /**
     * RBTPropertyToken 에서 호출 (balance 변경 직전)
     */
    function accrueFromAsset(address account, uint256 tokenId, uint256 balanceBefore) external whenNotPaused {
        if (msg.sender != asset) revert NotAsset();
        _accrue(tokenId, account, balanceBefore);
    }

    /**
     * 유저가 직접 호출해도 됨 (balance 현재값 기반)
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

        wft.mint(msg.sender, amt);
        emit Claimed(msg.sender, tokenId, amt);
    }

    // -------------------------
    // Internal
    // -------------------------

    function _accrue(uint256 tokenId, address account, uint256 balanceBefore) internal {
        if (account == address(0)) return;
        if (!seriesEnabled[tokenId]) {
            // series 비활성이라도 timestamp는 세팅해 두면 나중에 활성화 시 갑자기 누적되는 문제를 줄임
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

        // principal value in wei (18d): units * unitPrice
        uint256 principalWei = balanceUnits * unitPriceWei;
        uint256 accElapsed = elapsedSeconds * rateMultiplier;

        // interest = principal * aprBps * accElapsed / (BPS * YEAR_SECONDS)
        return (principalWei * aprBps * accElapsed) / (BPS * YEAR_SECONDS);
    }
}
