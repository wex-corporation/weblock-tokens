const { expect } = require("chai");
const { ethers } = require("hardhat");

async function deploySuite() {
  const [admin, treasury, alice, bob] = await ethers.getSigners();

  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy(admin.address);
  await usdt.waitForDeployment();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy(admin.address);
  await usdc.waitForDeployment();

  const Asset = await ethers.getContractFactory("WeBlockRwaAsset1155");
  const asset = await Asset.deploy(admin.address);
  await asset.waitForDeployment();

  const Sale = await ethers.getContractFactory("WeBlockRwaSaleEscrow");
  const sale = await Sale.deploy(admin.address, await asset.getAddress());
  await sale.waitForDeployment();

  const Interest = await ethers.getContractFactory("WeBlockRwaInterestVault");
  const interest = await Interest.deploy(admin.address, await asset.getAddress());
  await interest.waitForDeployment();

  const Redemption = await ethers.getContractFactory("WeBlockRwaRedemptionVault");
  const redemption = await Redemption.deploy(admin.address, await asset.getAddress());
  await redemption.waitForDeployment();

  await asset.grantRole(await asset.SALE_ROLE(), await sale.getAddress());
  await asset.grantRole(await asset.REFUND_ROLE(), await sale.getAddress());
  await asset.grantRole(await asset.REDEMPTION_ROLE(), await redemption.getAddress());
  await asset.setTransferHook(await interest.getAddress());

  const productId = 1n;
  const unitPrice = ethers.parseUnits("1", 6);

  await asset.configureProduct(
    productId,
    "Gangnam RWA #1",
    "GRWA1",
    "ipfs://gangnam-rwa-1",
    10,
    false
  );

  await sale.configureOffering(productId, 10, 0, 0, treasury.address, 1);
  await sale.configurePaymentToken(productId, await usdt.getAddress(), unitPrice, true);
  await sale.configurePaymentToken(productId, await usdc.getAddress(), unitPrice, true);

  await interest.configureRewardToken(productId, await usdt.getAddress(), true);
  await interest.configureRewardToken(productId, await usdc.getAddress(), true);

  await redemption.configureRedemption(productId, 0, 0, 1);
  await redemption.configurePayoutToken(productId, await usdt.getAddress(), unitPrice, true);
  await redemption.configurePayoutToken(productId, await usdc.getAddress(), ethers.parseUnits("2", 6), true);

  await usdt.mint(alice.address, ethers.parseUnits("100", 6));
  await usdt.mint(bob.address, ethers.parseUnits("100", 6));
  await usdt.mint(admin.address, ethers.parseUnits("1000", 6));
  await usdc.mint(alice.address, ethers.parseUnits("100", 6));
  await usdc.mint(bob.address, ethers.parseUnits("100", 6));
  await usdc.mint(admin.address, ethers.parseUnits("1000", 6));

  await usdt.connect(alice).approve(await sale.getAddress(), ethers.MaxUint256);
  await usdt.connect(bob).approve(await sale.getAddress(), ethers.MaxUint256);
  await usdc.connect(alice).approve(await sale.getAddress(), ethers.MaxUint256);
  await usdc.connect(bob).approve(await sale.getAddress(), ethers.MaxUint256);

  await usdt.approve(await interest.getAddress(), ethers.MaxUint256);
  await usdc.approve(await interest.getAddress(), ethers.MaxUint256);
  await usdt.approve(await redemption.getAddress(), ethers.MaxUint256);
  await usdc.approve(await redemption.getAddress(), ethers.MaxUint256);

  return {
    admin,
    treasury,
    alice,
    bob,
    usdt,
    usdc,
    asset,
    sale,
    interest,
    redemption,
    productId,
    unitPrice,
  };
}

describe("WeBlock RWA suite", function () {
  it("keeps sale funds in escrow until sold out and then releases them to treasury", async function () {
    const { alice, bob, treasury, usdt, asset, sale, productId, unitPrice } = await deploySuite();

    await sale.connect(alice).buy(productId, await usdt.getAddress(), 4, unitPrice * 4n);

    expect(await usdt.balanceOf(await sale.getAddress())).to.equal(unitPrice * 4n);
    expect(await usdt.balanceOf(treasury.address)).to.equal(0);
    expect(await asset.balanceOf(alice.address, productId)).to.equal(4);

    await expect(
      asset.connect(alice).safeTransferFrom(alice.address, bob.address, productId, 1, "0x")
    ).to.be.revertedWithCustomError(asset, "TransfersDisabled");

    await sale.connect(bob).buy(productId, await usdt.getAddress(), 6, unitPrice * 6n);

    expect(await usdt.balanceOf(await sale.getAddress())).to.equal(0);
    expect(await usdt.balanceOf(treasury.address)).to.equal(unitPrice * 10n);
    expect((await sale.offerings(productId)).status).to.equal(2);

    await asset.connect(alice).safeTransferFrom(alice.address, bob.address, productId, 1, "0x");
    expect(await asset.balanceOf(bob.address, productId)).to.equal(7);
  });

  it("supports refunds when the offering is cancelled or fails", async function () {
    const { alice, usdt, asset, sale, productId, unitPrice } = await deploySuite();

    await sale.connect(alice).buy(productId, await usdt.getAddress(), 3, unitPrice * 3n);
    await sale.cancelOffering(productId);

    const balanceBefore = await usdt.balanceOf(alice.address);
    await sale.connect(alice).claimRefund(productId);

    expect(await asset.balanceOf(alice.address, productId)).to.equal(0);
    expect(await usdt.balanceOf(alice.address)).to.equal(balanceBefore + unitPrice * 3n);
  });

  it("distributes interest proportionally and preserves accruals across transfers", async function () {
    const { alice, bob, usdt, asset, sale, interest, productId, unitPrice } = await deploySuite();

    await sale.connect(alice).buy(productId, await usdt.getAddress(), 6, unitPrice * 6n);
    await sale.connect(bob).buy(productId, await usdt.getAddress(), 4, unitPrice * 4n);

    await interest.fund(productId, await usdt.getAddress(), unitPrice * 10n);

    expect(await interest.claimable(productId, await usdt.getAddress(), alice.address)).to.equal(unitPrice * 6n);
    expect(await interest.claimable(productId, await usdt.getAddress(), bob.address)).to.equal(unitPrice * 4n);

    await asset.connect(alice).safeTransferFrom(alice.address, bob.address, productId, 1, "0x");
    await interest.fund(productId, await usdt.getAddress(), unitPrice * 10n);

    expect(await interest.claimable(productId, await usdt.getAddress(), alice.address)).to.equal(unitPrice * 11n);
    expect(await interest.claimable(productId, await usdt.getAddress(), bob.address)).to.equal(unitPrice * 9n);

    await interest.connect(alice).claim(productId, await usdt.getAddress());
    await interest.connect(bob).claim(productId, await usdt.getAddress());

    expect(await usdt.balanceOf(alice.address)).to.equal(ethers.parseUnits("105", 6));
    expect(await usdt.balanceOf(bob.address)).to.equal(ethers.parseUnits("105", 6));
  });

  it("redeems matured NFTs against funded stablecoin liquidity", async function () {
    const { alice, usdt, usdc, asset, sale, redemption, productId, unitPrice } = await deploySuite();

    await sale.connect(alice).buy(productId, await usdt.getAddress(), 10, unitPrice * 10n);

    await redemption.fund(productId, await usdc.getAddress(), ethers.parseUnits("20", 6));

    const usdcBefore = await usdc.balanceOf(alice.address);
    await redemption.connect(alice).redeem(productId, await usdc.getAddress(), 5);

    expect(await asset.balanceOf(alice.address, productId)).to.equal(5);
    expect(await usdc.balanceOf(alice.address)).to.equal(usdcBefore + ethers.parseUnits("10", 6));
    expect((await redemption.payoutOptions(productId, await usdc.getAddress())).availableAmount).to.equal(
      ethers.parseUnits("10", 6)
    );
  });
});
