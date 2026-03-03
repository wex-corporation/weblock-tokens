// scripts/12_deploy_interest_vault_for_asset.cjs
const { ethers } = require("hardhat");

/**
 * RBTInterestVault 배포 (asset 단위)
 *
 * Env required:
 * - RBT_ASSET=0x...
 * - REWARD_TOKEN=0x... (USDT on testnet)
 *
 * Optional:
 * - APR_BPS=1000 (10%)
 */
async function main() {
    const assetAddr = process.env.RBT_ASSET;
    const rewardTokenAddr = process.env.REWARD_TOKEN;
    if (!assetAddr || !rewardTokenAddr) throw new Error("Missing RBT_ASSET or REWARD_TOKEN in env");

    const [deployer] = await ethers.getSigners();
    const VaultF = await ethers.getContractFactory("RBTInterestVault");
    const vault = await VaultF.deploy(assetAddr, rewardTokenAddr, deployer.address);
    await vault.waitForDeployment();

    const addr = await vault.getAddress();
    console.log("RBTInterestVault deployed:", addr);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
