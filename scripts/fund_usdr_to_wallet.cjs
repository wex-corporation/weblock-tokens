/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

const CHAIN_ID = 43113;
const RPC_URL =
    process.env.RPC_URL ||
    "https://api.avax-test.network/ext/bc/C/rpc";

// === MUST SET ===
const DEPLOYER_PK = '0x189d0894a096b1adb37a7ed8dc6b872061903b3abf7212d5676416bd31dbf4a3'; // 0x04d9... deployer private key
if (!DEPLOYER_PK) {
    console.error("Missing DEPLOYER_PK in env");
    process.exit(1);
}

// === TARGETS (from your latest deployment output) ===
const USDR = "0x78695DaF4aC4E6Aa49340cE7A843B61855E04A28";
const TO = "0x57a0799F04246DC7119AEd7c64fD2675b769FEff";

// amount in "human" units (USDR decimals assumed 18, but we read onchain)
const AMOUNT_HUMAN = process.env.AMOUNT || "1500";

// Minimal ABI: balance, decimals, transfer, mint (optional), symbol
const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    // optional (some mocks/proxies expose it)
    "function mint(address to, uint256 amount)",
];

function fmt(n) {
    return ethers.formatEther(n);
}

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, {
        chainId: CHAIN_ID,
        name: "fuji",
    });

    const deployer = new ethers.Wallet(DEPLOYER_PK, provider);
    console.log("=== Fuji USDR Fund (CJS) ===");
    console.log("chainId :", CHAIN_ID);
    console.log("rpc    :", RPC_URL);
    console.log("deployer:", deployer.address);
    console.log("usdr   :", USDR);
    console.log("to     :", TO);

    // native gas check
    const native = await provider.getBalance(deployer.address);
    console.log("deployer native:", native.toString(), `(${fmt(native)} AVAX)`);
    if (native === 0n) {
        throw new Error("Deployer has 0 native AVAX. Need gas to send tx.");
    }

    const usdr = new ethers.Contract(USDR, ERC20_ABI, deployer);

    const [symbol, decimals] = await Promise.all([
        usdr.symbol().catch(() => "USDR"),
        usdr.decimals().catch(() => 18),
    ]);

    const amount = ethers.parseUnits(AMOUNT_HUMAN, decimals);

    console.log("--- Token ---");
    console.log("symbol  :", symbol);
    console.log("decimals:", decimals);
    console.log("amount  :", AMOUNT_HUMAN, symbol, `(raw=${amount.toString()})`);

    const [balDeployer, balTo] = await Promise.all([
        usdr.balanceOf(deployer.address),
        usdr.balanceOf(TO),
    ]);

    console.log("--- Balances (before) ---");
    console.log(
        "deployer:",
        balDeployer.toString(),
        `(${ethers.formatUnits(balDeployer, decimals)} ${symbol})`,
    );
    console.log(
        "to      :",
        balTo.toString(),
        `(${ethers.formatUnits(balTo, decimals)} ${symbol})`,
    );

    if (balDeployer >= amount) {
        console.log(`➡️ transfer(${TO}, ${AMOUNT_HUMAN} ${symbol}) ...`);
        const tx = await usdr.transfer(TO, amount);
        console.log("tx:", tx.hash);
        const rc = await tx.wait();
        console.log("✅ mined in block:", rc.blockNumber);
    } else {
        console.log(
            `deployer balance is insufficient for transfer. Trying mint(to, amount) ...`,
        );
        // attempt mint
        try {
            const tx = await usdr.mint(TO, amount);
            console.log("mint tx:", tx.hash);
            const rc = await tx.wait();
            console.log("✅ mint mined in block:", rc.blockNumber);
        } catch (e) {
            const msg =
                e?.shortMessage || e?.reason || e?.message || String(e);
            throw new Error(
                `Mint failed and deployer lacks balance for transfer. Reason: ${msg}`,
            );
        }
    }

    const balToAfter = await usdr.balanceOf(TO);
    console.log("--- Balances (after) ---");
    console.log(
        "to:",
        balToAfter.toString(),
        `(${ethers.formatUnits(balToAfter, decimals)} ${symbol})`,
    );

    console.log("✅ Done.");
}

main().catch((e) => {
    console.error("❌ Error:", e?.message || e);
    process.exit(1);
});
