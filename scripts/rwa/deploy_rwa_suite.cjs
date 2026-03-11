require("dotenv").config();

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DEFAULT_FUJI_USDT = "0x4CcEF90D730AB83366a3936FA301536649E105Ed";
const DEFAULT_EXPLORER = "https://testnet.snowtrace.io/address";

function envBigInt(name, fallback) {
  const value = process.env[name];
  return BigInt(value && value.length ? value : fallback);
}

function envNumber(name, fallback) {
  const value = process.env[name];
  return Number(value && value.length ? value : fallback);
}

async function deployContract(name, ...args) {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const nativeBalance = await hre.ethers.provider.getBalance(deployerAddress);

  const treasury = process.env.TREASURY_ADDRESS || deployerAddress;
  const productId = envBigInt("RWA_PRODUCT_ID", "1");
  const maxSupply = envBigInt("RWA_MAX_SUPPLY", "10000");
  const usdtAddress = process.env.RWA_USDT_ADDRESS || DEFAULT_FUJI_USDT;
  const usdtUnitPrice = envBigInt("RWA_USDT_UNIT_PRICE", "1000000");
  const usdcUnitPrice = envBigInt("RWA_USDC_UNIT_PRICE", "1000000");
  const redemptionUsdtUnitPrice = envBigInt(
    "RWA_REDEMPTION_USDT_UNIT_PRICE",
    usdtUnitPrice.toString()
  );
  const redemptionUsdcUnitPrice = envBigInt(
    "RWA_REDEMPTION_USDC_UNIT_PRICE",
    usdcUnitPrice.toString()
  );
  const usdcInitialMint = envBigInt("RWA_USDC_INITIAL_MINT", "1000000000000");
  const saleStart = envNumber("RWA_SALE_START", Math.floor(Date.now() / 1000) - 60);
  const saleEnd = envNumber("RWA_SALE_END", 0);
  const saleStatus = envNumber("RWA_SALE_STATUS", 1);
  const redemptionStart = envNumber("RWA_REDEMPTION_START", 0);
  const redemptionEnd = envNumber("RWA_REDEMPTION_END", 0);
  const redemptionStatus = envNumber("RWA_REDEMPTION_STATUS", 0);
  const productName = process.env.RWA_PRODUCT_NAME || "WeBlock Real Estate RWA #1";
  const productSymbol = process.env.RWA_PRODUCT_SYMBOL || "WBRWA1";
  const metadataUri = process.env.RWA_METADATA_URI || "ipfs://weblock-rwa-product-1";

  console.log("Deploying with:");
  console.log({
    network: hre.network.name,
    chainId,
    deployer: deployerAddress,
    nativeBalance: nativeBalance.toString(),
    treasury,
    productId: productId.toString(),
    maxSupply: maxSupply.toString(),
    usdtAddress,
    usdtUnitPrice: usdtUnitPrice.toString(),
    usdcUnitPrice: usdcUnitPrice.toString(),
  });

  const mockUsdc = await deployContract("MockUSDC", deployerAddress);
  if (usdcInitialMint > 0n) {
    const mintTx = await mockUsdc.mint(deployerAddress, usdcInitialMint);
    await mintTx.wait();
  }

  const asset = await deployContract("WeBlockRwaAsset1155", deployerAddress);
  const saleEscrow = await deployContract(
    "WeBlockRwaSaleEscrow",
    deployerAddress,
    await asset.getAddress()
  );
  const interestVault = await deployContract(
    "WeBlockRwaInterestVault",
    deployerAddress,
    await asset.getAddress()
  );
  const redemptionVault = await deployContract(
    "WeBlockRwaRedemptionVault",
    deployerAddress,
    await asset.getAddress()
  );

  await (await asset.grantRole(await asset.SALE_ROLE(), await saleEscrow.getAddress())).wait();
  await (await asset.grantRole(await asset.REFUND_ROLE(), await saleEscrow.getAddress())).wait();
  await (await asset.grantRole(await asset.REDEMPTION_ROLE(), await redemptionVault.getAddress())).wait();
  await (await asset.setTransferHook(await interestVault.getAddress())).wait();

  await (
    await asset.configureProduct(
      productId,
      productName,
      productSymbol,
      metadataUri,
      maxSupply,
      false
    )
  ).wait();

  await (
    await saleEscrow.configureOffering(
      productId,
      maxSupply,
      saleStart,
      saleEnd,
      treasury,
      saleStatus
    )
  ).wait();
  await (
    await saleEscrow.configurePaymentToken(
      productId,
      usdtAddress,
      usdtUnitPrice,
      true
    )
  ).wait();
  await (
    await saleEscrow.configurePaymentToken(
      productId,
      await mockUsdc.getAddress(),
      usdcUnitPrice,
      true
    )
  ).wait();

  await (await interestVault.configureRewardToken(productId, usdtAddress, true)).wait();
  await (
    await interestVault.configureRewardToken(productId, await mockUsdc.getAddress(), true)
  ).wait();

  await (
    await redemptionVault.configureRedemption(
      productId,
      redemptionStart,
      redemptionEnd,
      redemptionStatus
    )
  ).wait();
  await (
    await redemptionVault.configurePayoutToken(
      productId,
      usdtAddress,
      redemptionUsdtUnitPrice,
      true
    )
  ).wait();
  await (
    await redemptionVault.configurePayoutToken(
      productId,
      await mockUsdc.getAddress(),
      redemptionUsdcUnitPrice,
      true
    )
  ).wait();

  const deployment = {
    network: hre.network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    treasury,
    tokens: {
      usdt: usdtAddress,
      usdc: await mockUsdc.getAddress(),
    },
    contracts: {
      asset: await asset.getAddress(),
      saleEscrow: await saleEscrow.getAddress(),
      interestVault: await interestVault.getAddress(),
      redemptionVault: await redemptionVault.getAddress(),
    },
    product: {
      productId: productId.toString(),
      maxSupply: maxSupply.toString(),
      saleStart,
      saleEnd,
      saleStatus,
      unitPrices: {
        usdt: usdtUnitPrice.toString(),
        usdc: usdcUnitPrice.toString(),
      },
      redemption: {
        start: redemptionStart,
        end: redemptionEnd,
        status: redemptionStatus,
        unitPrices: {
          usdt: redemptionUsdtUnitPrice.toString(),
          usdc: redemptionUsdcUnitPrice.toString(),
        },
      },
      metadataUri,
      name: productName,
      symbol: productSymbol,
    },
    explorer: {
      asset: `${DEFAULT_EXPLORER}/${await asset.getAddress()}`,
      saleEscrow: `${DEFAULT_EXPLORER}/${await saleEscrow.getAddress()}`,
      interestVault: `${DEFAULT_EXPLORER}/${await interestVault.getAddress()}`,
      redemptionVault: `${DEFAULT_EXPLORER}/${await redemptionVault.getAddress()}`,
      usdc: `${DEFAULT_EXPLORER}/${await mockUsdc.getAddress()}`,
    },
  };

  const outputDir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${hre.network.name}-rwa-suite.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

  console.log("Deployment completed:");
  console.log(JSON.stringify(deployment, null, 2));
  console.log(`Saved to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
