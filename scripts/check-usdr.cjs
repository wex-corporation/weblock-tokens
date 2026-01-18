// scripts/check-usdr.cjs
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();

    // Defaults (Fuji)
    const USDR_ADDRESS =
        process.env.USDR_ADDRESS || "0xd5e04A32f7F8E35C8F7FE6F66793bd84453A689D";

    const usdr = await ethers.getContractAt("USDRToken", USDR_ADDRESS);

    const decimals = await usdr.decimals();
    const totalSupply = await usdr.totalSupply();
    const bal = await usdr.balanceOf(deployer.address);

    console.log("Network     :", (await ethers.provider.getNetwork()).name);
    console.log("Deployer    :", deployer.address);
    console.log("USDR        :", USDR_ADDRESS);
    console.log("Decimals    :", decimals.toString());
    console.log("TotalSupply :", ethers.formatUnits(totalSupply, decimals));
    console.log("Balance     :", ethers.formatUnits(bal, decimals));
    console.log("TotalSupplyWei :", totalSupply.toString());
    console.log("BalanceWei     :", bal.toString());
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
