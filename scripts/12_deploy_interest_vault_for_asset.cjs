// scripts/12_deploy_interest_vault_for_asset.cjs
const { ethers } = require("hardhat");

/**
 * RBTInterestVault 배포 (asset 단위)
 *
 * Env required:
 * - RBT_ASSET=0x...
 * - WFT=0x...
 *
 * Optional:
 * - APR_BPS=1000 (10%)
 */
async function main() {
    const assetAddr = process.env.RBT_ASSET;
    const wftAddr = process.env.WFT;
    if (!assetAddr || !wftAddr) throw new Error("Missing RBT_ASSET or WFT in env");

    const [deployer] = await ethers.getSigners();
    const aprBps = BigInt(process.env.APR_BPS || "1000");

    const VaultF = await ethers.getContractFactory("RBTInterestVault");
    const vault = await VaultF.deploy(assetAddr, wftAddr, deployer.address, aprBps);
    await vault.waitForDeployment();

    const addr = await vault.getAddress();
    console.log("RBTInterestVault deployed:", addr);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
