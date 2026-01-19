// scripts/13_interest_fund_and_claim.cjs
const { ethers } = require("hardhat");

/**
 * 이자 재원(WFT) 예치 + claim 테스트
 *
 * Env required:
 * - INTEREST_VAULT=0x...
 * - WFT=0x...
 * - TOKEN_IDS=1,2,3 (claim 시 조회할 RBT tokenId 목록)
 *
 * Optional:
 * - FUND_WFT=1000 (human, 18 decimals)
 * - BUYER=0x... (optional; default signer[1])
 */
async function main() {
    const vaultAddr = process.env.INTEREST_VAULT;
    const wftAddr = process.env.WFT;
    if (!vaultAddr || !wftAddr) throw new Error("Missing INTEREST_VAULT or WFT in env");

    const tokenIds = (process.env.TOKEN_IDS || "1").split(",").map((s) => BigInt(s.trim())).filter(Boolean);
    const [deployer, defaultBuyer] = await ethers.getSigners();
    const buyerAddr = process.env.BUYER || defaultBuyer.address;

    const wft = await ethers.getContractAt("WFTToken", wftAddr, deployer);
    const vault = await ethers.getContractAt("RBTInterestVault", vaultAddr, deployer);

    // 1) fund (operator=deployer)
    const fundHuman = process.env.FUND_WFT || "1000";
    const fundAmount = ethers.parseUnits(fundHuman, 18);
    // WFTToken은 mint 권한이 deployer에 있으므로 바로 mint 후 fund
    await (await wft.mint(deployer.address, fundAmount)).wait();
    await (await wft.approve(vaultAddr, fundAmount)).wait();
    await (await vault.fund(fundAmount)).wait();
    console.log("Funded WFT:", fundAmount.toString());

    // 2) buyer claim
    const buyerSigner =
        buyerAddr.toLowerCase() === defaultBuyer.address.toLowerCase()
            ? defaultBuyer
            : await ethers.getImpersonatedSigner(buyerAddr);

    const vaultBuyer = await ethers.getContractAt("RBTInterestVault", vaultAddr, buyerSigner);

    // 첫 claim은 기준점만 잡고 0 반환
    const tx1 = await vaultBuyer.claim(tokenIds);
    await tx1.wait();
    console.log("First claim executed (should be 0)");

    // 10초 정도 시간 경과 후 다시 claim (로컬 hardhat이면 evm_increaseTime 사용 가능)
    try {
        await ethers.provider.send("evm_increaseTime", [60]);
        await ethers.provider.send("evm_mine", []);
    } catch {
        // 실네트워크에서는 skip
    }

    const pending = await vaultBuyer.pending(buyerAddr, tokenIds);
    console.log("Pending:", pending.toString());
    const tx2 = await vaultBuyer.claim(tokenIds);
    await tx2.wait();
    console.log("Claimed.");
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
