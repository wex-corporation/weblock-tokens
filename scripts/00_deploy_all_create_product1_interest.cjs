/* eslint-disable no-console */
const hre = require("hardhat");
const { ethers, upgrades } = hre;

function env(name, defVal) {
    const v = process.env[name];
    return v === undefined || v === "" ? defVal : v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTx(tx, label) {
    console.log(`➡️  tx sent: ${label} hash=${tx.hash}`);
    const rc = await tx.wait(1); // 1 conf
    console.log(`✅ tx mined: ${label} block=${rc.blockNumber}`);
    return rc;
}

async function withRetry(fn, label, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            if (i > 0) {
                console.log(`🔁 retry ${i}/${retries - 1}: ${label}`);
                await sleep(1500 * i);
            }
            return await fn();
        } catch (e) {
            lastErr = e;
            const msg = e?.shortMessage || e?.reason || e?.message || String(e);
            console.warn(`⚠️ failed: ${label}: ${msg}`);
            // headers timeout 계열은 짧게 쉬고 재시도하면 대부분 회복
            await sleep(2000);
        }
    }
    throw lastErr;
}

async function safeDeployProxy(factory, args, opts, label) {
    return await withRetry(async () => {
        console.log(`\n=== deployProxy: ${label} ===`);
        const c = await upgrades.deployProxy(factory, args, opts);
        await c.waitForDeployment();
        const addr = await c.getAddress();
        console.log(`✅ deployed: ${label} proxy=${addr}`);
        return c;
    }, `deployProxy(${label})`, 3);
}

async function main() {
    // provider polling 완화
    try {
        ethers.provider.pollingInterval = 2000;
    } catch {}

    const [deployer] = await ethers.getSigners();
    const net = await ethers.provider.getNetwork();

    const TREASURY = env("TREASURY", deployer.address);

    // Keep two offeringIds for backward compatibility, but both offerings use USDT.
    const OFFERING_ID_USDR = BigInt(env("OFFERING_ID_USDR", "1"));
    const OFFERING_ID_USDT = BigInt(env("OFFERING_ID_USDT", "2"));
    const SERIES_LABEL = env("SERIES_LABEL", "1호");
    const MAX_SUPPLY = BigInt(env("MAX_SUPPLY", "10000"));
    const REMAINING_UNITS = BigInt(env("REMAINING_UNITS", "10000"));

    // Payment token is USDT (6 decimals). Unit price for offering/series is in token smallest units.
    const UNIT_PRICE_USDT = ethers.parseUnits(env("UNIT_PRICE_USDT", "1"), 6);

    // Interest calculation uses 18-decimal USD-wei as a neutral unit.
    const INTEREST_UNIT_PRICE_WEI = ethers.parseUnits(env("INTEREST_UNIT_PRICE", "1"), 18);

    const APR_BPS = BigInt(env("APR_BPS", "1000"));
    const RATE_MULTIPLIER = BigInt(env("RATE_MULTIPLIER", "100000"));

    const INVESTOR = env("INVESTOR", "");
    const FUND_NATIVE_AVAX = env("FUND_NATIVE_AVAX", "0.05");
    const FUND_USDT = env("FUND_USDT", "50");

    console.log("=== Deploy & Create Product #1 (Fresh) ===");
    console.log("Network   :", `${env("NETWORK", "fuji")} ${Number(net.chainId)}`);
    console.log("Deployer  :", deployer.address);
    console.log("Treasury  :", TREASURY);

    // 1) USDR (UUPS Proxy)
    const USDR = await ethers.getContractFactory("USDRToken");
    const usdr = await safeDeployProxy(
        USDR,
        [deployer.address, "ipfs://USDR_DISCLOSURES_URI"],
        { kind: "uups" },
        "USDR"
    );
    const usdrAddr = await usdr.getAddress();
    console.log("USDR (proxy):", usdrAddr);

    // 2) USDT (Mock)
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await withRetry(async () => {
        console.log("\n=== deploy: MockUSDT ===");
        const c = await MockUSDT.deploy(deployer.address);
        await c.waitForDeployment();
        console.log("✅ deployed: MockUSDT", await c.getAddress());
        return c;
    }, "deploy(MockUSDT)", 3);
    const usdtAddr = await usdt.getAddress();
    console.log("USDT (mock):", usdtAddr);

    // 3) RBTPropertyToken implementation
    const RBTImplF = await ethers.getContractFactory("RBTPropertyToken");
    const rbtImpl = await withRetry(async () => {
        console.log("\n=== deploy: RBTPropertyToken (impl) ===");
        const c = await RBTImplF.deploy();
        await c.waitForDeployment();
        console.log("✅ deployed: RBT impl", await c.getAddress());
        return c;
    }, "deploy(RBT impl)", 3);
    const rbtImplAddr = await rbtImpl.getAddress();

    // 5) Factory
    const FactoryF = await ethers.getContractFactory("RBTAssetFactory");
    const factory = await withRetry(async () => {
        console.log("\n=== deploy: RBTAssetFactory ===");
        const c = await FactoryF.deploy(rbtImplAddr, deployer.address);
        await c.waitForDeployment();
        console.log("✅ deployed: factory", await c.getAddress());
        return c;
    }, "deploy(factory)", 3);
    const factoryAddr = await factory.getAddress();
    console.log("RBT factory:", factoryAddr);

    // 6) Router
    const RouterF = await ethers.getContractFactory("RBTPrimarySaleRouter");
    const router = await withRetry(async () => {
        console.log("\n=== deploy: RBTPrimarySaleRouter ===");
        const c = await RouterF.deploy(deployer.address);
        await c.waitForDeployment();
        console.log("✅ deployed: router", await c.getAddress());
        return c;
    }, "deploy(router)", 3);
    const routerAddr = await router.getAddress();
    console.log("InvestRouter:", routerAddr);

    // allow payment tokens
    await waitTx(await router.setPaymentTokenAllowed(usdtAddr, true), "router.setPaymentTokenAllowed(USDT)");

    // 7) Create asset clone
    const createAssetRc = await withRetry(async () => {
        console.log("\n=== factory.createAsset ===");
        const tx = await factory.createAsset(
            "WeBlock Asset #1",
            "RBT-A1",
            "WeBlock Property #1",
            usdtAddr,
            deployer.address
        );
        return await waitTx(tx, "factory.createAsset");
    }, "factory.createAsset", 3);

    let assetAddr = "";
    for (const log of createAssetRc.logs) {
        try {
            const parsed = factory.interface.parseLog(log);
            if (parsed?.args?.asset) assetAddr = parsed.args.asset;
        } catch {}
    }
    if (!assetAddr) throw new Error("Failed to parse asset from AssetCreated event.");
    console.log("RBT asset(clone):", assetAddr);

    const asset = await ethers.getContractAt("RBTPropertyToken", assetAddr);

    // 8) Create series
    const createSeriesRc = await withRetry(async () => {
        console.log("\n=== asset.createSeries ===");
        const tx = await asset.createSeries(SERIES_LABEL, UNIT_PRICE_USDT, MAX_SUPPLY);
        return await waitTx(tx, "asset.createSeries");
    }, "asset.createSeries", 3);

    let seriesId;
    for (const log of createSeriesRc.logs) {
        try {
            const parsed = asset.interface.parseLog(log);
            if (parsed?.args?.tokenId !== undefined) seriesId = parsed.args.tokenId;
        } catch {}
    }
    if (seriesId === undefined) throw new Error("Failed to parse seriesId(tokenId) from SeriesCreated event.");
    console.log("SeriesId(tokenId):", seriesId.toString());

    // 9) Grant ISSUER_ROLE to router
    const issuerRole = await asset.ISSUER_ROLE();
    await waitTx(await asset.grantRole(issuerRole, routerAddr), "asset.grantRole(ISSUER_ROLE, router)");
    console.log("Granted ISSUER_ROLE to InvestRouter");

    // 10) Offerings
    await waitTx(
        await router.upsertOffering(
            OFFERING_ID_USDR,
            assetAddr,
            seriesId,
            usdtAddr,
            UNIT_PRICE_USDT,
            REMAINING_UNITS,
            0,
            0,
            TREASURY,
            true
        ),
        "router.upsertOffering(USDT, legacy offeringId)"
    );

    await waitTx(
        await router.upsertOffering(
            OFFERING_ID_USDT,
            assetAddr,
            seriesId,
            usdtAddr,
            UNIT_PRICE_USDT,
            REMAINING_UNITS,
            0,
            0,
            TREASURY,
            true
        ),
        "router.upsertOffering(USDT)"
    );

    console.log(
        "Offerings upserted:",
        OFFERING_ID_USDR.toString(),
        "(USDT, legacy offeringId)",
        OFFERING_ID_USDT.toString(),
        "(USDT)"
    );

    // 11) InterestVault deploy + config + wire
    const VaultF = await ethers.getContractFactory("RBTInterestVault");
    const vault = await withRetry(async () => {
        console.log("\n=== deploy: RBTInterestVault ===");
        const c = await VaultF.deploy(assetAddr, usdtAddr, deployer.address);
        await c.waitForDeployment();
        console.log("✅ deployed: vault", await c.getAddress());
        return c;
    }, "deploy(vault)", 3);
    const vaultAddr = await vault.getAddress();

    await waitTx(
        await vault.configureSeries(seriesId, INTEREST_UNIT_PRICE_WEI, true),
        "vault.configureSeries"
    );
    await waitTx(await vault.setAprBps(APR_BPS), "vault.setAprBps");
    await waitTx(await vault.setRateMultiplier(RATE_MULTIPLIER), "vault.setRateMultiplier");

    await waitTx(await asset.setInterestVault(vaultAddr), "asset.setInterestVault");
    console.log("setInterestVault(...) on asset ✅");

    // 12) Optional funding
    if (INVESTOR && ethers.isAddress(INVESTOR)) {
        console.log("\n=== Optional Funding ===");
        console.log("Investor:", INVESTOR);

        const invNative = await ethers.provider.getBalance(INVESTOR);
        if (invNative === 0n) {
            const value = ethers.parseEther(FUND_NATIVE_AVAX);
            console.log(`Funding AVAX: ${FUND_NATIVE_AVAX} ...`);
            const tx = await deployer.sendTransaction({ to: INVESTOR, value });
            await waitTx(tx, "deployer.sendTransaction(fund avax)");
        } else {
            console.log("Investor already has native:", invNative.toString());
        }

        console.log(`Mint USDT: ${FUND_USDT} ...`);
        await waitTx(await usdt.mint(INVESTOR, ethers.parseUnits(FUND_USDT, 6)), "usdt.mint");

        console.log("Funding done ✅");
    }

    console.log("\n=== DEPLOYMENT RESULT ===");
    console.log(
        JSON.stringify(
            {
                network: { name: env("NETWORK", "fuji"), chainId: Number(net.chainId) },
                deployer: deployer.address,
                treasury: TREASURY,
                contracts: {
                    usdr: usdrAddr,
                    usdt: usdtAddr,
                    rbtImpl: rbtImplAddr,
                    rbtFactory: factoryAddr,
                    investRouter: routerAddr,
                    rbtAsset: assetAddr,
                    interestVault: vaultAddr,
                },
                product1: {
                    seriesId: seriesId.toString(),
                    maxSupply: MAX_SUPPLY.toString(),
                    offerings: [
                        {
                            offeringId: OFFERING_ID_USDR.toString(),
                            paymentToken: "USDT",
                            paymentTokenAddr: usdtAddr,
                            unitPrice: UNIT_PRICE_USDT.toString(),
                            remainingUnits: REMAINING_UNITS.toString(),
                        },
                        {
                            offeringId: OFFERING_ID_USDT.toString(),
                            paymentToken: "USDT",
                            paymentTokenAddr: usdtAddr,
                            unitPrice: UNIT_PRICE_USDT.toString(),
                            remainingUnits: REMAINING_UNITS.toString(),
                        },
                    ],
                    interest: {
                        aprBps: APR_BPS.toString(),
                        rateMultiplier: RATE_MULTIPLIER.toString(),
                        unitPriceWei: INTEREST_UNIT_PRICE_WEI.toString(),
                    },
                },
            },
            null,
            2
        )
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
