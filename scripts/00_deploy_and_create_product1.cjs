// scripts/00_deploy_and_create_product1.cjs
// Deploy: USDR(UUPS), USDT(mock 6dec), WFT(UUPS), RBT impl+factory, InvestRouter
// Then create product #1: Asset(clone) + Series(1호) + Offering(offeringId=1) on InvestRouter

const { ethers, upgrades } = require("hardhat");

function env(name, fallback = undefined) {
    const v = process.env[name];
    return (v === undefined || v === "") ? fallback : v;
}

async function parseEventArgs(contract, receipt, eventName) {
    for (const log of receipt.logs) {
        try {
            const parsed = contract.interface.parseLog(log);
            if (parsed && parsed.name === eventName) return parsed.args;
        } catch (_) {}
    }
    return null;
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();

    const TREASURY = env("TREASURY", deployer.address);
    const OFFERING_ID = BigInt(env("OFFERING_ID", "1"));
    const SERIES_LABEL = env("SERIES_LABEL", "1호");
    const SERIES_MAX_SUPPLY = BigInt(env("SERIES_MAX_SUPPLY", "10000"));

    const PAYMENT_TOKEN = (env("PAYMENT_TOKEN", "USDR") || "USDR").toUpperCase(); // USDR | USDT
    const UNIT_PRICE_HUMAN = env("UNIT_PRICE", "1");
    const USDR_DISCLOSURES_URI = env("USDR_DISCLOSURES_URI", "ipfs://USDR_DISCLOSURES");
    const WFT_TERMS_URI = env("WFT_TERMS_URI", "ipfs://WFT_TERMS");

    console.log("=== Deploy & Create Product #1 ===");
    console.log("Network   :", network.name, Number(network.chainId));
    console.log("Deployer  :", deployer.address);
    console.log("Treasury  :", TREASURY);
    console.log("Payment   :", PAYMENT_TOKEN, "UNIT_PRICE =", UNIT_PRICE_HUMAN);
    console.log("OfferingId:", OFFERING_ID.toString());
    console.log("Series    :", SERIES_LABEL, "maxSupply =", SERIES_MAX_SUPPLY.toString());

    // -----------------------------
    // 1) Deploy USDR (UUPS Proxy)
    // -----------------------------
    const USDR = await ethers.getContractFactory("USDRToken");
    const usdr = await upgrades.deployProxy(
        USDR,
        [deployer.address, USDR_DISCLOSURES_URI],
        { kind: "uups" }
    );
    await usdr.waitForDeployment();
    const usdrAddr = await usdr.getAddress();
    console.log("USDR (proxy):", usdrAddr);

    // -----------------------------
    // 2) Deploy USDT (Mock 6 decimals)
    // -----------------------------
    const USDT = await ethers.getContractFactory("USDT");
    const usdt = await USDT.deploy(
        env("USDT_NAME", "Tether USD (Test)"),
        env("USDT_SYMBOL", "USDT"),
        ethers.parseUnits(env("USDT_INITIAL_SUPPLY", "1000000"), 6),
        deployer.address
    );
    await usdt.waitForDeployment();
    const usdtAddr = await usdt.getAddress();
    console.log("USDT (mock):", usdtAddr);

    // -----------------------------
    // 3) Deploy WFT (UUPS Proxy)
    // -----------------------------
    const WFT = await ethers.getContractFactory("WFTToken");
    const wft = await upgrades.deployProxy(
        WFT,
        [deployer.address, WFT_TERMS_URI],
        { kind: "uups" }
    );
    await wft.waitForDeployment();
    const wftAddr = await wft.getAddress();
    console.log("WFT (proxy):", wftAddr);

    // -----------------------------
    // 4) Deploy RBTPropertyToken implementation + Factory
    // -----------------------------
    const RBTImplF = await ethers.getContractFactory("RBTPropertyToken");
    const rbtImpl = await RBTImplF.deploy();
    await rbtImpl.waitForDeployment();
    const rbtImplAddr = await rbtImpl.getAddress();
    console.log("RBT impl:", rbtImplAddr);

    const FactoryF = await ethers.getContractFactory("RBTAssetFactory");
    const factory = await FactoryF.deploy(rbtImplAddr, deployer.address);
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    console.log("RBT factory:", factoryAddr);

    // -----------------------------
    // 5) Deploy InvestRouter (USDR/USDT 결제 가능)
    // -----------------------------
    const InvestF = await ethers.getContractFactory("RBTInvestmentRouter");
    const investRouter = await InvestF.deploy(deployer.address);
    await investRouter.waitForDeployment();
    const investRouterAddr = await investRouter.getAddress();
    console.log("InvestRouter:", investRouterAddr);

    // -----------------------------
    // 6) Create Asset (clone) for Product #1
    // settlementToken은 USDR로 고정 (RBT 내부 정산/배당용)
    // -----------------------------
    const txCreateAsset = await factory.createAsset(
        env("ASSET_NAME", "WeBlock Product #1"),
        env("ASSET_SYMBOL", "RBT-P1"),
        env("ASSET_LABEL", "위블록 1호"),
        usdrAddr,
        deployer.address
    );
    const rcCreateAsset = await txCreateAsset.wait();
    const evAsset = await parseEventArgs(factory, rcCreateAsset, "AssetCreated");
    if (!evAsset) throw new Error("Failed to parse AssetCreated event");
    const rbtAssetAddr = evAsset.asset;
    console.log("RBT asset(clone):", rbtAssetAddr);

    const rbtAsset = await ethers.getContractAt("RBTPropertyToken", rbtAssetAddr, deployer);

    // MVP: 필터링 비활성화 확실히
    try {
        await (await rbtAsset.setComplianceEnabled(false)).wait();
    } catch (_) {
        // 구버전 호환
    }

    // -----------------------------
    // 7) Create Series "1호" (tokenId) on that asset
    // NOTE: 여기 unitPrice는 RBT 내부 메타(회계/정산용)로 유지해도 되고 0으로도 가능하지만,
    // 현재 컨트랙트는 0을 허용하므로 의미있는 값(예: 1,000,000) 넣는 것을 권장
    // -----------------------------
    const seriesUnitPriceMeta = BigInt(env("SERIES_UNIT_PRICE_META", "1000000")); // 예: 1,000,000 (의미만)
    const txSeries = await rbtAsset.createSeries(
        SERIES_LABEL,
        seriesUnitPriceMeta,
        SERIES_MAX_SUPPLY
    );
    const rcSeries = await txSeries.wait();
    const evSeries = await parseEventArgs(rbtAsset, rcSeries, "SeriesCreated");
    if (!evSeries) throw new Error("Failed to parse SeriesCreated event");
    const seriesId = evSeries.tokenId;
    console.log("SeriesId(tokenId):", seriesId.toString());

    // -----------------------------
    // 8) Grant ISSUER_ROLE to InvestRouter so it can mint(issue) RBT on purchase
    // -----------------------------
    const ISSUER_ROLE = await rbtAsset.ISSUER_ROLE();
    const hasIssuer = await rbtAsset.hasRole(ISSUER_ROLE, investRouterAddr);
    if (!hasIssuer) {
        await (await rbtAsset.grantRole(ISSUER_ROLE, investRouterAddr)).wait();
    }
    console.log("Granted ISSUER_ROLE to InvestRouter");

    // -----------------------------
    // 9) Upsert Offering (offeringId=1) on InvestRouter
    // paymentToken: USDR or USDT
    // decimals: USDR=18, USDT=6
    // -----------------------------
    const paymentTokenAddr = PAYMENT_TOKEN === "USDT" ? usdtAddr : usdrAddr;
    const paymentDecimals = PAYMENT_TOKEN === "USDT" ? 6 : 18;
    const unitPrice = ethers.parseUnits(UNIT_PRICE_HUMAN, paymentDecimals);

    await (await investRouter.upsertOffering(
        OFFERING_ID,
        rbtAssetAddr,
        seriesId,
        paymentTokenAddr,
        unitPrice,
        SERIES_MAX_SUPPLY, // remainingUnits = maxSupply
        0,
        0,
        TREASURY,
        true
    )).wait();

    console.log("Offering upserted on InvestRouter");

    // -----------------------------
    // 10) Summary
    // -----------------------------
    const summary = {
        network: { name: network.name, chainId: Number(network.chainId) },
        deployer: deployer.address,
        treasury: TREASURY,
        contracts: {
            usdr: usdrAddr,
            usdt: usdtAddr,
            wft: wftAddr,
            rbtImpl: rbtImplAddr,
            rbtFactory: factoryAddr,
            investRouter: investRouterAddr,
            rbtAsset: rbtAssetAddr,
        },
        product1: {
            offeringId: OFFERING_ID.toString(),
            seriesId: seriesId.toString(),
            paymentToken: PAYMENT_TOKEN,
            paymentTokenAddr,
            unitPriceWei: unitPrice.toString(),
            remainingUnits: SERIES_MAX_SUPPLY.toString(),
        },
    };

    console.log("\n=== DEPLOYMENT RESULT ===");
    console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
