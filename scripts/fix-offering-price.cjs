// scripts/fix-offering-and-activate.cjs
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();

    const SALE_ROUTER =
        process.env.SALE_ROUTER || "0x0121Cb6D579AE40CCDD686470e5d74cd1b105C77";
    const USDR =
        process.env.USDR || "0xd5e04A32f7F8E35C8F7FE6F66793bd84453A689D";

    const OFFERING_ID = BigInt(process.env.OFFERING_ID || "1");
    const RBT_ASSET =
        process.env.RBT_ASSET || "0x239B91DC11975376327314392adc27c59b3CE001";
    const SERIES_ID = BigInt(process.env.SERIES_ID || "1");
    const MAX_SUPPLY = BigInt(process.env.MAX_SUPPLY || "10000");
    const TREASURY =
        process.env.TREASURY || "0x04d974094Ac7BE61e1cf9ED9eaD858090D742Ef8";

    const usdr = await ethers.getContractAt("USDRToken", USDR);
    const decimals = await usdr.decimals();
    const unitPriceWei = ethers.parseUnits("1", decimals); // 1 USDR

    console.log("Deployer   :", deployer.address);
    console.log("SaleRouter :", SALE_ROUTER);
    console.log("USDR       :", USDR, "decimals:", decimals.toString());
    console.log("OfferingId :", OFFERING_ID.toString());
    console.log("RBT Asset  :", RBT_ASSET);
    console.log("seriesId   :", SERIES_ID.toString());
    console.log("unitPriceWei:", unitPriceWei.toString());
    console.log("maxSupply  :", MAX_SUPPLY.toString());
    console.log("treasury   :", TREASURY);

    const router = new ethers.Contract(
        SALE_ROUTER,
        [
            // overloads
            "function upsertOffering(uint256 offeringId, address rbtAssetAddress, uint256 seriesId, uint256 unitPriceWei, uint256 maxSupply, address treasury) external",
            "function upsertOffering(uint256 offeringId, address rbtAssetAddress, uint256 seriesId, uint256 unitPriceWei, uint256 maxSupply, address treasury, bool active) external",

            // some routers have these
            "function setOfferingActive(uint256 offeringId, bool active) external",
            "function activateOffering(uint256 offeringId) external",

            // readback
            "function offerings(uint256) view returns (address rbtAssetAddress, uint256 seriesId, uint256 unitPriceWei, uint256 maxSupply, address treasury, bool active)",
            "function getOffering(uint256) view returns (address rbtAssetAddress, uint256 seriesId, uint256 unitPriceWei, uint256 maxSupply, address treasury, bool active)",
        ],
        deployer
    );

    // 1) 우선 active를 포함하는 7-args 버전부터 시도 (가장 안전)
    let didUpsert = false;
    try {
        const tx = await router[
            "upsertOffering(uint256,address,uint256,uint256,uint256,address,bool)"
            ](
            OFFERING_ID,
            RBT_ASSET,
            SERIES_ID,
            unitPriceWei,
            MAX_SUPPLY,
            TREASURY,
            true
        );
        console.log("upsert(7) tx:", tx.hash);
        await tx.wait();
        didUpsert = true;
    } catch (e) {
        console.log("upsert(7) failed, trying upsert(6)...");
    }

    // 2) 6-args 버전 시도
    if (!didUpsert) {
        const tx = await router[
            "upsertOffering(uint256,address,uint256,uint256,uint256,address)"
            ](OFFERING_ID, RBT_ASSET, SERIES_ID, unitPriceWei, MAX_SUPPLY, TREASURY);
        console.log("upsert(6) tx:", tx.hash);
        await tx.wait();
    }

    // 3) active가 여전히 false면 활성화 함수 시도
    try {
        const tx = await router["setOfferingActive(uint256,bool)"](OFFERING_ID, true);
        console.log("setOfferingActive tx:", tx.hash);
        await tx.wait();
    } catch (_) {
        try {
            const tx = await router["activateOffering(uint256)"](OFFERING_ID);
            console.log("activateOffering tx:", tx.hash);
            await tx.wait();
        } catch (_) {}
    }

    // 4) read-back
    let o;
    try {
        o = await router.offerings(OFFERING_ID);
    } catch {
        o = await router.getOffering(OFFERING_ID);
    }

    console.log("---- read-back ----");
    console.log("rbtAssetAddress:", o.rbtAssetAddress);
    console.log("seriesId       :", o.seriesId.toString());
    console.log("unitPriceWei   :", o.unitPriceWei.toString());
    console.log("maxSupply      :", o.maxSupply.toString());
    console.log("treasury       :", o.treasury);
    console.log("active         :", o.active);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
