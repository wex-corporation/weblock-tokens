// scripts/mint-usdr.cjs
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();

    const USDR_ADDRESS =
        process.env.USDR_ADDRESS || "0xd5e04A32f7F8E35C8F7FE6F66793bd84453A689D";

    // mint 받을 주소 (기본: deployer=treasury)
    const TO =
        process.env.TO || deployer.address;

    // 사람이 읽는 단위(USDR) 기준. 예: AMOUNT=1000 이면 1000 USDR
    const AMOUNT = process.env.AMOUNT || "100000000000000000000000000";

    const usdr = await ethers.getContractAt("USDRToken", USDR_ADDRESS);
    const decimals = await usdr.decimals();

    // MINTER_ROLE = keccak256("MINTER_ROLE")
    const MINTER_ROLE = ethers.id("MINTER_ROLE");
    const ok = await usdr.hasRole(MINTER_ROLE, deployer.address);
    if (!ok) {
        throw new Error(`Deployer has no MINTER_ROLE: ${deployer.address}`);
    }

    const amtWei = ethers.parseUnits(AMOUNT, decimals);

    console.log("Deployer:", deployer.address);
    console.log("USDR    :", USDR_ADDRESS);
    console.log("TO      :", TO);
    console.log("AMOUNT  :", AMOUNT, "USDR");
    console.log("Wei     :", amtWei.toString());

    const tx = await usdr.mint(TO, amtWei);
    console.log("mint tx :", tx.hash);
    await tx.wait();

    const bal = await usdr.balanceOf(TO);
    console.log("New Balance:", ethers.formatUnits(bal, decimals));
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
