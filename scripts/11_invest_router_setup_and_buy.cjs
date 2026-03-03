// scripts/11_invest_router_setup_and_buy.cjs
const { ethers } = require("hardhat");

/**
 * MVP 투자 플로우 (USDR 또는 USDT로 RBT 구매)
 *
 * Env required:
 * - RBT_ASSET=0x... (asset clone 주소)
 * - INVEST_ROUTER=0x... (RBTInvestmentRouter)
 * - TREASURY=0x... (optional, default: deployer)
 * - OFFERING_ID=1 (optional)
 * - SERIES_ID=1 (optional)
 * - PAYMENT_TOKEN=USDR|USDT|0x... (optional, default: USDR)
 * - PAYMENT_TOKEN_ADDR=0x... (optional; if set overrides PAYMENT_TOKEN)
 * - UNIT_PRICE=1 (optional, human; payment token decimals에 맞춰 parse)
 * - PAYMENT_DECIMALS=18 or 6 (optional; default: 18)
 * - REMAINING_UNITS=0 (optional)
 * - BUYER=0x... (optional; default: signer[1])
 * - BUY_UNITS=10 (optional)
 * - MINT_TO_BUYER=true|false (optional, default true)
 */
async function main() {
    const assetAddr = process.env.RBT_ASSET;
    const investRouterAddr = process.env.INVEST_ROUTER;
    if (!assetAddr || !investRouterAddr) {
        throw new Error("Missing RBT_ASSET or INVEST_ROUTER in env");
    }

    const [deployer, defaultBuyer] = await ethers.getSigners();
    const buyerAddr = process.env.BUYER || defaultBuyer.address;
    const treasury = process.env.TREASURY || deployer.address;

    const offeringId = BigInt(process.env.OFFERING_ID || "1");
    const seriesId = BigInt(process.env.SERIES_ID || "1");
    const remainingUnits = BigInt(process.env.REMAINING_UNITS || "0");
    const buyUnits = BigInt(process.env.BUY_UNITS || "10");

    // resolve payment token
    const paymentDecimals = Number(process.env.PAYMENT_DECIMALS || "18");
    let paymentTokenAddr = process.env.PAYMENT_TOKEN_ADDR;
    if (!paymentTokenAddr) {
        const alias = (process.env.PAYMENT_TOKEN || "USDR").toUpperCase();
        if (alias === "USDR") paymentTokenAddr = process.env.USDR;
        else if (alias === "USDT") paymentTokenAddr = process.env.USDT;
    }
    if (!paymentTokenAddr) {
        throw new Error("Missing payment token address. Set PAYMENT_TOKEN_ADDR or (PAYMENT_TOKEN + USDR/USDT env)");
    }

    const unitPrice = ethers.parseUnits(process.env.UNIT_PRICE || "1", paymentDecimals);

    const asset = await ethers.getContractAt("RBTPropertyToken", assetAddr, deployer);
    const invest = await ethers.getContractAt("RBTInvestmentRouter", investRouterAddr, deployer);

    // grant ISSUER_ROLE to router (needed for issue)
    const ISSUER_ROLE = await asset.ISSUER_ROLE();
    const has = await asset.hasRole(ISSUER_ROLE, investRouterAddr);
    if (!has) {
        await (await asset.grantRole(ISSUER_ROLE, investRouterAddr)).wait();
    }

    // upsert offering
    await (await invest.upsertOffering(
        offeringId,
        assetAddr,
        seriesId,
        paymentTokenAddr,
        unitPrice,
        remainingUnits,
        0,
        0,
        treasury,
        true
    )).wait();

    // optionally mint payment tokens to buyer (USDRToken/USDT both have mint in this repo)
    const shouldMint = (process.env.MINT_TO_BUYER || "true").toLowerCase() !== "false";
    const cost = unitPrice * buyUnits;

    if (shouldMint) {
        // try USDRToken first, then USDT
        try {
            const usdr = await ethers.getContractAt("USDRToken", paymentTokenAddr, deployer);
            await (await usdr.mint(buyerAddr, cost)).wait();
        } catch {
            const usdt = await ethers.getContractAt("USDT", paymentTokenAddr, deployer);
            await (await usdt.mint(buyerAddr, cost)).wait();
        }
    }

    const buyerSigner =
        buyerAddr.toLowerCase() === defaultBuyer.address.toLowerCase()
            ? defaultBuyer
            : await ethers.getImpersonatedSigner(buyerAddr);

    const payBuyer = await ethers.getContractAt(
        // ABI는 둘 다 ERC20이므로 최소 approve만 있으면 됨
        "IERC20",
        paymentTokenAddr,
        buyerSigner
    );

    // hardhat getContractAt("IERC20")은 artifact가 없으면 실패할 수 있으니,
    // 대신 USDRToken/USDT 중 하나로 시도
    let payToken;
    try {
        payToken = await ethers.getContractAt("USDRToken", paymentTokenAddr, buyerSigner);
    } catch {
        payToken = await ethers.getContractAt("USDT", paymentTokenAddr, buyerSigner);
    }

    const investBuyer = await ethers.getContractAt("RBTInvestmentRouter", investRouterAddr, buyerSigner);

    await (await payToken.approve(investRouterAddr, cost)).wait();
    await (await investBuyer.buy(offeringId, buyUnits, cost)).wait();

    const bal = await asset.balanceOf(buyerAddr, seriesId);
    console.log("Buyer RBT balance:", bal.toString());
    console.log("Cost:", cost.toString(), "paymentToken:", paymentTokenAddr);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
