/* scripts/fund_signer_once.cjs */
/* eslint-disable no-console */

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const TARGET_SIGNER = "0x7e05Cdc7450c5d51409a322Ef7d76755fAB00A03";

// your deployed USDR on Fuji
const USDR = "0xbc3A31c1788624E5bFf69cdC3a1E7405A01C6De2";

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function mint(address to, uint256 value)",
];

const MIN_AVAX = "0.02";     // if target has less than this, top-up
const TOPUP_AVAX = "0.05";   // send this amount
const FUND_USDR = "1500";    // ensure target >= this (human units)

function fmt(n) {
    return typeof n === "bigint" ? n.toString() : String(n);
}

async function main() {
    if (!process.env.DEPLOYER_PK) throw new Error("DEPLOYER_PK missing");

    const net = await ethers.provider.getNetwork();
    if (net.chainId !== 43113n) {
        console.log("WARNING: expected Fuji chainId 43113, got:", net.chainId.toString());
    }

    const deployer = new ethers.Wallet(process.env.DEPLOYER_PK, ethers.provider);

    console.log("=== Fund Signer Once ===");
    console.log("chainId:", net.chainId.toString());
    console.log("deployer:", deployer.address);
    console.log("target signer:", TARGET_SIGNER);
    console.log("");

    // ---------- 1) Fund AVAX (gas) ----------
    const minWei = ethers.parseEther(MIN_AVAX);
    const topupWei = ethers.parseEther(TOPUP_AVAX);

    const depNative = await ethers.provider.getBalance(deployer.address);
    const tgtNative = await ethers.provider.getBalance(TARGET_SIGNER);

    console.log("--- Native AVAX ---");
    console.log("deployer native:", fmt(depNative), `(${ethers.formatEther(depNative)} AVAX)`);
    console.log("target native(before):", fmt(tgtNative), `(${ethers.formatEther(tgtNative)} AVAX)`);

    if (tgtNative < minWei) {
        if (depNative < topupWei) {
            throw new Error(
                `Deployer has insufficient AVAX to top-up. need=${TOPUP_AVAX}, have=${ethers.formatEther(depNative)}`
            );
        }
        console.log(`-> sending ${TOPUP_AVAX} AVAX to target...`);
        const tx = await deployer.sendTransaction({ to: TARGET_SIGNER, value: topupWei });
        console.log("avax tx:", tx.hash);
        await tx.wait();
    } else {
        console.log("✅ target already has enough AVAX for gas.");
    }

    const tgtNativeAfter = await ethers.provider.getBalance(TARGET_SIGNER);
    console.log("target native(after):", fmt(tgtNativeAfter), `(${ethers.formatEther(tgtNativeAfter)} AVAX)`);
    console.log("");

    // ---------- 2) Fund USDR ----------
    const usdr = new ethers.Contract(USDR, ERC20_ABI, deployer);

    let symbol = "USDR";
    let decimals = 18;
    try { symbol = await usdr.symbol(); } catch {}
    try { decimals = Number(await usdr.decimals()); } catch {}

    const targetAmount = ethers.parseUnits(FUND_USDR, decimals);

    const depTok = await usdr.balanceOf(deployer.address);
    const tgtTok = await usdr.balanceOf(TARGET_SIGNER);

    console.log("--- Token ---");
    console.log("token:", USDR);
    console.log("symbol:", symbol, "decimals:", decimals);
    console.log("deployer token:", fmt(depTok), `(${ethers.formatUnits(depTok, decimals)} ${symbol})`);
    console.log("target token(before):", fmt(tgtTok), `(${ethers.formatUnits(tgtTok, decimals)} ${symbol})`);

    const need = targetAmount > tgtTok ? (targetAmount - tgtTok) : 0n;

    if (need === 0n) {
        console.log(`✅ target already has >= ${FUND_USDR} ${symbol}`);
    } else {
        console.log(`Need additional: ${ethers.formatUnits(need, decimals)} ${symbol}`);

        // Try mint first
        let done = false;
        try {
            console.log("-> try mint(to, amount)...");
            const tx = await usdr.mint(TARGET_SIGNER, need);
            console.log("mint tx:", tx.hash);
            await tx.wait();
            console.log("✅ mint success");
            done = true;
        } catch (e) {
            const msg = e && (e.shortMessage || e.message) ? (e.shortMessage || e.message) : String(e);
            console.log("mint failed:", msg);
        }

        // Fallback to transfer
        if (!done) {
            const depTok2 = await usdr.balanceOf(deployer.address);
            if (depTok2 < need) {
                throw new Error(
                    `Deployer token insufficient for transfer. need=${ethers.formatUnits(need, decimals)} ${symbol}, have=${ethers.formatUnits(depTok2, decimals)}`
                );
            }
            console.log("-> transfer(to, amount)...");
            const tx = await usdr.transfer(TARGET_SIGNER, need);
            console.log("transfer tx:", tx.hash);
            await tx.wait();
            console.log("✅ transfer success");
        }
    }

    const tgtTokAfter = await usdr.balanceOf(TARGET_SIGNER);
    console.log("target token(after):", fmt(tgtTokAfter), `(${ethers.formatUnits(tgtTokAfter, decimals)} ${symbol})`);

    console.log("\n✅ Done. Retry investment in frontend. It should pass gas + have USDR.");
}

main().catch((e) => {
    console.error("❌ Script failed:", e);
    process.exitCode = 1;
});
