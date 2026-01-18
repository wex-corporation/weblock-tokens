// scripts/whitelist-buyer.cjs
// Usage:
//   BUYER=0x... RBT_ASSET=0x... npx hardhat run scripts/whitelist-buyer.cjs --network fuji

const { ethers } = require("hardhat");

async function main() {
  const buyer = process.env.BUYER;
  const rbtAsset = process.env.RBT_ASSET;

  if (!buyer || !rbtAsset) {
    throw new Error("Missing env vars: BUYER and RBT_ASSET are required.");
  }

  const [signer] = await ethers.getSigners();
  console.log("Signer :", signer.address);
  console.log("Buyer  :", buyer);
  console.log("RBT    :", rbtAsset);

  const asset = await ethers.getContractAt("RBTPropertyToken", rbtAsset, signer);

  // For router.buy() to work, buyer must be whitelisted in RBTPropertyToken.
  const before = await asset.whitelisted(buyer);
  console.log("whitelisted(before):", before);

  const tx = await asset.setWhitelist(buyer, true);
  console.log("tx:", tx.hash);
  await tx.wait();

  const after = await asset.whitelisted(buyer);
  console.log("whitelisted(after):", after);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
