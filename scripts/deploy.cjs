// scripts/deploy.cjs
const { ethers, upgrades } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();

    // 1) USDR (UUPS Proxy)
    const USDR = await ethers.getContractFactory("USDRToken");
    const usdr = await upgrades.deployProxy(
        USDR,
        [deployer.address, "ipfs://USDR_DISCLOSURES_URI"],
        { kind: "uups" }
    );
    await usdr.waitForDeployment();
    const usdrAddr = await usdr.getAddress();

    // 1.1) USDT (Mock, 6 decimals)
    const USDT = await ethers.getContractFactory("USDT");
    const usdt = await USDT.deploy(
        process.env.USDT_NAME || "Tether USD (Test)",
        process.env.USDT_SYMBOL || "USDT",
        ethers.parseUnits(process.env.USDT_INITIAL_SUPPLY || "1000000", 6),
        deployer.address
    );
    await usdt.waitForDeployment();
    const usdtAddr = await usdt.getAddress();

    // 2) RBTPropertyToken implementation
    const RBTImplF = await ethers.getContractFactory("RBTPropertyToken");
    const rbtImpl = await RBTImplF.deploy();
    await rbtImpl.waitForDeployment();
    const rbtImplAddr = await rbtImpl.getAddress();

    // 3) Factory (restricted)
    const FactoryF = await ethers.getContractFactory("RBTAssetFactory");
    const factory = await FactoryF.deploy(rbtImplAddr, deployer.address);
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();

    // 4) Revenue Vault
    const VaultF = await ethers.getContractFactory("RBTMonthlyRevenueVault");
    const vault = await VaultF.deploy(usdrAddr, deployer.address);
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    // 5) RBT Primary Sale Router
// (기존 deploy.cjs 중간에 추가)
    const SaleF = await ethers.getContractFactory("RBTPrimarySaleRouter");
    const saleRouter = await SaleF.deploy(usdrAddr, deployer.address);
    await saleRouter.waitForDeployment();
    const saleRouterAddr = await saleRouter.getAddress();
    console.log("SaleRouter   :", saleRouterAddr);

    // 5.1) RBT Investment Router (USDR/USDT 둘 다 가능)
    const InvestRouterF = await ethers.getContractFactory("RBTInvestmentRouter");
    const investRouter = await InvestRouterF.deploy(deployer.address);
    await investRouter.waitForDeployment();
    const investRouterAddr = await investRouter.getAddress();

    // 5.2) RBT Interest Vault (WFT 지급, 기본 10% APR)
    // 실제 사용 시, rbtAsset(clone) 주소를 넣어야 하지만
    // 여기서는 배포 단계에서 아직 asset을 생성하지 않으므로 'placeholder'로 배포하지 않습니다.
    // -> 아래 scripts/12_deploy_interest_vault_for_asset.cjs 참고

    // 6) WFT (UUPS Proxy)
    const WFT = await ethers.getContractFactory("WFTToken");
    const wft = await upgrades.deployProxy(
        WFT,
        [deployer.address, "ipfs://WFT_TERMS_URI"],
        { kind: "uups" }
    );
    await wft.waitForDeployment();
    const wftAddr = await wft.getAddress();

    // 7) WFTStaking
    const StakingF = await ethers.getContractFactory("WFTStaking");
    const staking = await StakingF.deploy(wftAddr, deployer.address, usdrAddr);
    await staking.waitForDeployment();

    console.log(JSON.stringify({
        usdr: usdrAddr,
        usdt: usdtAddr,
        rbtImpl: rbtImplAddr,
        rbtFactory: factoryAddr,
        revenueVault: vaultAddr,
        saleRouter: saleRouterAddr,
        investRouter: investRouterAddr,
        wft: wftAddr
    }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
