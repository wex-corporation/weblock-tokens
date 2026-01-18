// scripts/send-usdr.cjs
const { ethers } = require("hardhat");

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
];

function mustGetEnv(name, fallback) {
    const v = process.env[name] ?? fallback;
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

async function main() {
    const to = mustGetEnv(
        "TO",
        "0x57a0799F04246DC7119AEd7c64fD2675b769FEff"
    );
    const usdrAddress = mustGetEnv(
        "USDR",
        "0xd5e04A32f7F8E35C8F7FE6F66793bd84453A689D"
    );
    const amountHuman = mustGetEnv("AMOUNT", "100"); // 기본 100 USDR

    const [sender] = await ethers.getSigners();
    console.log("Sender  :", sender.address);
    console.log("To      :", to);
    console.log("USDR    :", usdrAddress);
    console.log("Amount  :", amountHuman, "USDR");

    const usdr = new ethers.Contract(usdrAddress, ERC20_ABI, sender);

    const decimals = await usdr.decimals();
    const amount = ethers.parseUnits(amountHuman, decimals);

    const senderBalBefore = await usdr.balanceOf(sender.address);
    const toBalBefore = await usdr.balanceOf(to);

    console.log("Sender balance(before):", ethers.formatUnits(senderBalBefore, decimals));
    console.log("To balance(before)    :", ethers.formatUnits(toBalBefore, decimals));

    if (senderBalBefore < amount) {
        throw new Error("Insufficient USDR balance in sender wallet");
    }

    const tx = await usdr.transfer(to, amount);
    console.log("Tx hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Mined in block:", receipt.blockNumber, "status:", receipt.status);

    const senderBalAfter = await usdr.balanceOf(sender.address);
    const toBalAfter = await usdr.balanceOf(to);

    console.log("Sender balance(after):", ethers.formatUnits(senderBalAfter, decimals));
    console.log("To balance(after)    :", ethers.formatUnits(toBalAfter, decimals));
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
