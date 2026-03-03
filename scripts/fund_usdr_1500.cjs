/* scripts/fund_usdr_1500.cjs */
/* eslint-disable no-console */

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const USDR = "0xbc3A31c1788624E5bFf69cdC3a1E7405A01C6De2";
const TO = "0x61c8652E10Ed382C67d3C561c81ae7977488B0FF";
const AMOUNT_USDR = "1500"; // human units

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function mint(address to, uint256 value)",
];

async function main() {
    if (!process.env.DEPLOYER_PK) throw new Error("DEPLOYER_PK missing");

    const deployer = new ethers.Wallet(process.env.DEPLOYER_PK, ethers.provider);
    const token = new ethers.Contract(USDR, ERC20_ABI, deployer);

    let symbol = "TOKEN";
    let decimals = 18;
    try { symbol = await token.symbol(); } catch {}
    try { decimals = Number(await token.decimals()); } catch {}

    const amount = ethers.parseUnits(AMOUNT_USDR, decimals);

    console.log("=== Fund USDR ===");
    console.log("chainId:", (await ethers.provider.getNetwork()).chainId.toString());
    console.log("deployer:", deployer.address);
    console.log("token:", USDR, `(${symbol}, decimals=${decimals})`);
    console.log("to:", TO);
    console.log("amount:", AMOUNT_USDR, symbol, `(raw=${amount.toString()})`);
    console.log("");

    const before = await token.balanceOf(TO);
    console.log("to balance(before):", ethers.formatUnits(before, decimals), symbol);

    // 1) Try mint
    let done = false;
    try {
        console.log("-> try mint(to, amount) ...");
        const tx = await token.mint(TO, amount);
        console.log("mint tx:", tx.hash);
        await tx.wait();
        console.log("✅ mint success");
        done = true;
    } catch (e) {
        const msg = e && (e.shortMessage || e.message) ? (e.shortMessage || e.message) : String(e);
        console.log("mint failed:", msg);
    }

    // 2) Fallback to transfer if mint failed
    if (!done) {
        const depBal = await token.balanceOf(deployer.address);
        console.log("deployer token balance:", ethers.formatUnits(depBal, decimals), symbol);

        if (depBal < amount) {
            throw new Error(
                `Deployer lacks ${symbol}. need=${AMOUNT_USDR}, have=${ethers.formatUnits(depBal, decimals)}`
            );
        }

        console.log("-> transfer(to, amount) ...");
        const tx = await token.transfer(TO, amount);
        console.log("transfer tx:", tx.hash);
        await tx.wait();
        console.log("✅ transfer success");
    }

    const after = await token.balanceOf(TO);
    console.log("to balance(after):", ethers.formatUnits(after, decimals), symbol);
}

main().catch((e) => {
    console.error("❌ Script failed:", e);
    process.exitCode = 1;
});
