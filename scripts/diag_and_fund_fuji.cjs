/* scripts/diag_and_fund_fuji.cjs */
/* eslint-disable no-console */

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

/**
 * Fuji 43113 - your deployed addresses
 * InvestRouter: 0x41c1...34e6
 * OfferingId: 1
 */
const ADDR = {
    INVEST_ROUTER: "0x41c1EeD232D29FCc19c09b0e26A70e4B8c9b34e6",
    OFFERING_ID: 1n,
};

const INVEST_ROUTER_ABI = [
    // (asset, seriesId, paymentToken, unitPrice, remainingUnits, startAt, endAt, treasury, enabled)
    "function offerings(uint256) view returns (address,uint256,address,uint256,uint256,uint64,uint64,address,bool)",
];

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
    // optional mock function
    "function mint(address to, uint256 value)",
];

function envStr(name, fallback) {
    const v = process.env[name];
    return v && String(v).trim().length ? String(v).trim() : fallback;
}

function envNum(name, fallback) {
    const v = envStr(name, null);
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

async function fmtEth(wei) {
    return ethers.formatEther(wei);
}

async function main() {
    const deployerPk = process.env.DEPLOYER_PK;
    if (!deployerPk) throw new Error("DEPLOYER_PK is required in .env");

    const deployer = new ethers.Wallet(deployerPk, ethers.provider);

    const investorAddr = envStr(
        "INVESTOR_ADDR",
        "0xf147F86d317765B56741DDcF9F8398D95F39c612"
    );

    const minInvestorAvax = envNum("MIN_INVESTOR_AVAX", 0.02);
    const fundInvestorAvax = envNum("FUND_INVESTOR_AVAX", 0.05);
    const fundPaymentToken = envNum("FUND_PAYMENT_TOKEN", 20);

    const net = await ethers.provider.getNetwork();

    console.log("=== Fuji One-Click Diagnose & Fund (CJS) ===");
    console.log("chainId:", net.chainId.toString());
    console.log("deployer:", deployer.address);
    console.log("investor:", investorAddr);
    console.log("");

    // 1) Read offering
    const router = new ethers.Contract(
        ADDR.INVEST_ROUTER,
        INVEST_ROUTER_ABI,
        ethers.provider
    );

    const off = await router.offerings(ADDR.OFFERING_ID);

    const asset = off[0];
    const seriesId = off[1];
    const paymentToken = off[2];
    const unitPrice = off[3];
    const remaining = off[4];
    const treasury = off[7];
    const enabled = off[8];

    console.log("--- Offering ---");
    console.log("router:", ADDR.INVEST_ROUTER);
    console.log("offeringId:", ADDR.OFFERING_ID.toString());
    console.log("asset:", asset);
    console.log("seriesId:", seriesId.toString());
    console.log("paymentToken:", paymentToken);
    console.log("unitPrice(wei):", unitPrice.toString());
    console.log("remainingUnits:", remaining.toString());
    console.log("treasury:", treasury);
    console.log("enabled:", enabled);
    console.log("");

    if (!enabled) {
        console.log("❌ Offering is disabled. Enable it on-chain first.");
        return;
    }

    // 2) Native AVAX balances
    const depNative = await ethers.provider.getBalance(deployer.address);
    const invNative = await ethers.provider.getBalance(investorAddr);

    console.log("--- Native AVAX ---");
    console.log(
        "deployer native:",
        depNative.toString(),
        `(${await fmtEth(depNative)} AVAX)`
    );
    console.log(
        "investor native:",
        invNative.toString(),
        `(${await fmtEth(invNative)} AVAX)`
    );
    console.log("");

    const minWei = ethers.parseEther(String(minInvestorAvax));
    const fundWei = ethers.parseEther(String(fundInvestorAvax));

    if (invNative < minWei) {
        if (depNative < fundWei) {
            console.log(
                `❌ Deployer lacks AVAX to fund. need=${fundInvestorAvax} AVAX, deployer=${await fmtEth(
                    depNative
                )}`
            );
        } else {
            console.log(`➡️ Funding investor AVAX: ${fundInvestorAvax} AVAX ...`);
            const tx = await deployer.sendTransaction({ to: investorAddr, value: fundWei });
            console.log("fund tx:", tx.hash);
            await tx.wait();

            const invNative2 = await ethers.provider.getBalance(investorAddr);
            console.log(
                "investor native(after):",
                invNative2.toString(),
                `(${await fmtEth(invNative2)} AVAX)`
            );
        }
    } else {
        console.log("✅ Investor has enough AVAX for gas.");
    }
    console.log("");

    // 3) Payment token diagnose
    const token = new ethers.Contract(paymentToken, ERC20_ABI, ethers.provider);
    let symbol = "TOKEN";
    let decimals = 18;

    try {
        symbol = await token.symbol();
    } catch {}
    try {
        decimals = Number(await token.decimals());
    } catch {}

    const tokenAsDeployer = token.connect(deployer);

    const depTokBal = await token.balanceOf(deployer.address);
    const invTokBal = await token.balanceOf(investorAddr);

    console.log("--- Payment Token ---");
    console.log("token:", paymentToken);
    console.log("symbol:", symbol);
    console.log("decimals:", decimals);
    console.log(
        "deployer token balance:",
        depTokBal.toString(),
        `(${ethers.formatUnits(depTokBal, decimals)} ${symbol})`
    );
    console.log(
        "investor token balance:",
        invTokBal.toString(),
        `(${ethers.formatUnits(invTokBal, decimals)} ${symbol})`
    );
    console.log("");

    // 4) Funding plan: ensure investor >= FUND_PAYMENT_TOKEN
    const target = ethers.parseUnits(String(fundPaymentToken), decimals);
    const needDelta = target > invTokBal ? target - invTokBal : 0n;

    console.log("--- Funding Plan ---");
    console.log(`target investor token >= ${fundPaymentToken} ${symbol}`);
    console.log(`need additional token amount (raw): ${needDelta.toString()}`);
    console.log("");

    if (needDelta === 0n) {
        console.log("✅ Investor already has enough payment token.");
        console.log("\nDone. You can now test approve+buy from frontend.");
        return;
    }

    // 5) Prefer mint (if possible), else transfer from deployer
    let minted = false;

    try {
        console.log("➡️ Trying mint(to, amount) from deployer (if token supports it)...");
        const tx = await tokenAsDeployer.mint(investorAddr, needDelta);
        console.log("mint tx:", tx.hash);
        await tx.wait();
        minted = true;
        console.log("✅ Mint succeeded.");
    } catch (e) {
        console.log("mint not usable here (no function or no permission).");
        const msg = e && (e.shortMessage || e.message) ? (e.shortMessage || e.message) : String(e);
        console.log("mint error:", msg);
    }

    if (!minted) {
        if (depTokBal < needDelta) {
            console.log("❌ Deployer token balance insufficient for transfer.");
            console.log(`need=${ethers.formatUnits(needDelta, decimals)} ${symbol}`);
            console.log(`deployer=${ethers.formatUnits(depTokBal, decimals)} ${symbol}`);
            console.log("");
            console.log("Action needed:");
            console.log("1) If this token is a mock, redeploy with mint enabled OR grant mint role to deployer.");
            console.log("2) Or transfer tokens from whichever address holds the initial supply to investor.");
            return;
        }

        console.log(
            `➡️ Transferring ${ethers.formatUnits(needDelta, decimals)} ${symbol} from deployer -> investor...`
        );
        const tx = await tokenAsDeployer.transfer(investorAddr, needDelta);
        console.log("transfer tx:", tx.hash);
        await tx.wait();
        console.log("✅ Transfer succeeded.");
    }

    const invTokBal2 = await token.balanceOf(investorAddr);

    console.log("");
    console.log("--- Result ---");
    console.log(
        "investor token balance(after):",
        invTokBal2.toString(),
        `(${ethers.formatUnits(invTokBal2, decimals)} ${symbol})`
    );

    console.log("\n✅ Done. Now you can run approve+buy from frontend (PurchaseArea).");
}

main().catch((e) => {
    console.error("❌ Script failed:", e);
    process.exitCode = 1;
});
