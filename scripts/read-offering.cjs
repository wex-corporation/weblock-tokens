// scripts/read-offering.cjs
// Usage:
//   SALE_ROUTER=0x... OFFERING_ID=1 npx hardhat run scripts/read-offering.cjs --network fuji

const { ethers } = require("hardhat");

async function main() {
  const saleRouterAddr = process.env.SALE_ROUTER;
  const offeringId = process.env.OFFERING_ID;

  if (!saleRouterAddr || !offeringId) {
    throw new Error("Missing env vars: SALE_ROUTER and OFFERING_ID are required.");
  }

  const router = await ethers.getContractAt("RBTPrimarySaleRouter", saleRouterAddr);
  const o = await router.offerings(offeringId);

  console.log(JSON.stringify({
    offeringId: offeringId,
    asset: o.asset,
    seriesId: o.seriesId?.toString?.() ?? String(o.seriesId),
    unitPriceWei: o.unitPrice?.toString?.() ?? String(o.unitPrice),
    remainingUnits: o.remainingUnits?.toString?.() ?? String(o.remainingUnits),
    startAt: o.startAt?.toString?.() ?? String(o.startAt),
    endAt: o.endAt?.toString?.() ?? String(o.endAt),
    treasury: o.treasury,
    enabled: o.enabled,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
