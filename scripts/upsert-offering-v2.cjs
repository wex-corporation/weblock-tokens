// scripts/upsert-offering-v2.cjs
// Purpose: Upsert offering (enable + set treasury) for the 9-arg upsertOffering signature.
// Usage:
//   SALE_ROUTER=0x... OFFERING_ID=1 RBT_ASSET=0x... SERIES_ID=1 UNIT_PRICE_WEI=1000000000000000000 MAX_SUPPLY=10000 TREASURY=0x... \
//     npx hardhat run scripts/upsert-offering-v2.cjs --network fuji

const { ethers } = require("hardhat");

async function main() {
  const saleRouterAddr = process.env.SALE_ROUTER;
  const offeringId = BigInt(process.env.OFFERING_ID ?? "0");
  const asset = process.env.RBT_ASSET;
  const seriesId = BigInt(process.env.SERIES_ID ?? "0");
  const unitPrice = BigInt(process.env.UNIT_PRICE_WEI ?? "0");
  const maxSupply = BigInt(process.env.MAX_SUPPLY ?? "0");
  const treasury = process.env.TREASURY;

  if (!saleRouterAddr || !asset || !treasury) {
    throw new Error("Missing env vars: SALE_ROUTER, RBT_ASSET, TREASURY are required.");
  }

  const [signer] = await ethers.getSigners();
  console.log("Signer    :", signer.address);
  console.log("SaleRouter :", saleRouterAddr);

  const router = await ethers.getContractAt("RBTPrimarySaleRouter", saleRouterAddr, signer);

  // upsertOffering(uint256,address,uint256,uint256,uint256,uint64,uint64,address,bool)
  const tx = await router.upsertOffering(
    offeringId,
    asset,
    seriesId,
    unitPrice,
    maxSupply,
    0,
    0,
    treasury,
    true,
  );

  console.log("tx:", tx.hash);
  await tx.wait();

  const o = await router.offerings(offeringId);
  console.log("updated:", {
    asset: o.asset,
    seriesId: o.seriesId.toString(),
    unitPriceWei: o.unitPrice.toString(),
    remainingUnits: o.remainingUnits.toString(),
    treasury: o.treasury,
    enabled: o.enabled,
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
