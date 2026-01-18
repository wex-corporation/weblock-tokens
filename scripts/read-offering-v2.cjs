const { ethers } = require("hardhat");

async function main() {
    const SALE_ROUTER = process.env.SALE_ROUTER || "0x0121Cb6D579AE40CCDD686470e5d74cd1b105C77";
    const OFFERING_ID = BigInt(process.env.OFFERING_ID || "1");

    const router = new ethers.Contract(
        SALE_ROUTER,
        [
            "function offerings(uint256) view returns (address asset,uint256 seriesId,uint256 unitPrice,uint256 remainingUnits,uint64 startAt,uint64 endAt,address treasury,bool enabled)",
        ],
        ethers.provider
    );

    const o = await router.offerings(OFFERING_ID);

    console.log("SaleRouter :", SALE_ROUTER);
    console.log("OfferingId :", OFFERING_ID.toString());
    console.log("asset          :", o.asset);
    console.log("seriesId       :", o.seriesId.toString());
    console.log("unitPriceWei   :", o.unitPrice.toString());
    console.log("remainingUnits :", o.remainingUnits.toString());
    console.log("startAt        :", o.startAt.toString());
    console.log("endAt          :", o.endAt.toString());
    console.log("treasury       :", o.treasury);
    console.log("enabled        :", o.enabled);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
