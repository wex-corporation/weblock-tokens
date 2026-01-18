// scripts/fix-offering-and-activate.cjs
// Purpose: Ensure offering is correctly configured (treasury != 0x0) and enabled=true.
//
// Usage (recommended):
//   SALE_ROUTER=0x... RBT_ASSET=0x... OFFERING_ID=1 SERIES_ID=1 \
//   UNIT_PRICE_WEI=1000000000000000000 REMAINING_UNITS=10000 TREASURY=0x... \
//   npx hardhat run scripts/fix-offering-and-activate.cjs --network fuji
//
// Notes:
// - Different historical versions of RBTPrimarySaleRouter used different upsertOffering overloads.
// - This script tries the newest signature first and falls back to older overloads.

const { ethers } = require("hardhat");

const ZERO = "0x0000000000000000000000000000000000000000";

async function main() {
  const saleRouterAddr = process.env.SALE_ROUTER;
  const rbtAssetAddr = process.env.RBT_ASSET;
  const offeringId = BigInt(process.env.OFFERING_ID || "1");
  const seriesId = BigInt(process.env.SERIES_ID || "1");
  const unitPriceWei = BigInt(process.env.UNIT_PRICE_WEI || "1000000000000000000");
  const remainingUnits = BigInt(process.env.REMAINING_UNITS || "0");
  const treasury = process.env.TREASURY;

  if (!saleRouterAddr || !rbtAssetAddr || !treasury) {
    throw new Error("Missing env vars: SALE_ROUTER, RBT_ASSET, TREASURY are required.");
  }
  if (treasury.toLowerCase() === ZERO) {
    throw new Error("TREASURY must not be zero address.");
  }

  const [signer] = await ethers.getSigners();
  console.log("Signer    :", signer.address);
  console.log("SaleRouter :", saleRouterAddr);
  console.log("RBT Asset  :", rbtAssetAddr);
  console.log("OfferingId :", offeringId.toString());
  console.log("SeriesId   :", seriesId.toString());
  console.log("UnitPrice  :", unitPriceWei.toString());
  console.log("RemainUnits:", remainingUnits.toString());
  console.log("Treasury   :", treasury);

  const saleRouter = await ethers.getContractAt("RBTPrimarySaleRouter", saleRouterAddr, signer);

  // Newest signature (current contract in this conversation)
  const startAt = BigInt(0);
  const endAt = BigInt(0);
  const enabled = true;

  const attempts = [
    {
      sig: "upsertOffering(uint256,address,uint256,uint256,uint256,uint64,uint64,address,bool)",
      args: [offeringId, rbtAssetAddr, seriesId, unitPriceWei, remainingUnits, Number(startAt), Number(endAt), treasury, enabled],
    },
    // Older overloads (historical)
    {
      sig: "upsertOffering(uint256,address,uint256,uint256,uint256,address,bool)",
      args: [offeringId, rbtAssetAddr, seriesId, unitPriceWei, remainingUnits, treasury, enabled],
    },
    {
      sig: "upsertOffering(uint256,address,uint256,uint256,uint256,address)",
      args: [offeringId, rbtAssetAddr, seriesId, unitPriceWei, remainingUnits, treasury],
    },
  ];

  let lastErr;
  for (const a of attempts) {
    try {
      if (typeof saleRouter[a.sig] !== "function") {
        console.log("Skip (not in ABI):", a.sig);
        continue;
      }
      console.log("Calling:", a.sig);
      const tx = await saleRouter[a.sig](...a.args);
      console.log("tx:", tx.hash);
      await tx.wait();
      console.log("Offering upserted and (if supported) enabled=true");
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      console.log("Failed:", a.sig);
      console.log(e?.shortMessage || e?.message || e);
    }
  }

  if (lastErr) {
    throw lastErr;
  }

  // Read back offering (newest struct signature) if possible
  try {
    const off = await saleRouter.offerings(offeringId);
    console.log("offerings(offeringId):", off);
  } catch (e) {
    console.log("Read offering skipped (ABI mismatch):", e?.shortMessage || e?.message || e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
