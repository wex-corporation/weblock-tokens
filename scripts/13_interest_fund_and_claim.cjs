/**
 * scripts/13_interest_fund_and_claim.cjs
 *
 * Fuji-safe version:
 * - Does NOT rely on a second signer (defaultBuyer) being present.
 * - Does NOT use impersonation on Fuji (only allowed on local hardhat).
 * - BUYER must be the deployer address on Fuji.
 *
 * ENV REQUIRED:
 *  - INTEREST_VAULT=0x...
 *  - REWARD_TOKEN=0x...          (MockUSDT deployed by your scripts)
 *  - TOKEN_IDS=1 or "1,2,3"
 *
 * ENV OPTIONAL:
 *  - FUND_REWARD=1000            (human-readable, e.g. 1000 USDT)
 *  - BUYER=0x...                 (on Fuji MUST equal deployer address)
 */

require("dotenv").config();
const { ethers, network } = require("hardhat");

function mustEnv(key) {
    const v = process.env[key];
    if (!v || !String(v).trim()) {
        throw new Error(`Missing required env: ${key}`);
    }
    return String(v).trim();
}

function normalizeAddr(addr) {
    return ethers.getAddress(addr);
}

function parseTokenIds(raw) {
    const s = String(raw || "").trim();
    if (!s) throw new Error("TOKEN_IDS is empty");
    return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => BigInt(x));
}

async function tryMintIfPossible(token, to, amountNeeded) {
    // Try mint(to, amount)
    // If mint doesn't exist, this will fail silently and return false.
    try {
        const tx = await token.mint(to, amountNeeded);
        await tx.wait();
        console.log(`Minted reward token to ${to}: ${amountNeeded.toString()}`);
        return true;
    } catch (e) {
        return false;
    }
}

async function main() {
    const net = await ethers.provider.getNetwork();
    const chainId = Number(net.chainId);

    const [deployer] = await ethers.getSigners();

    const INTEREST_VAULT = normalizeAddr(mustEnv("INTEREST_VAULT"));
    const REWARD_TOKEN = normalizeAddr(mustEnv("REWARD_TOKEN"));
    const TOKEN_IDS = parseTokenIds(mustEnv("TOKEN_IDS"));

    const fundRewardHuman = String(process.env.FUND_REWARD || "1000").trim();

    const buyerEnv = process.env.BUYER ? normalizeAddr(process.env.BUYER) : deployer.address;
    const buyerAddr = buyerEnv.toLowerCase();
    const deployerAddr = deployer.address.toLowerCase();

    // Fuji / public networks: do not allow impersonation
    // We require buyer == deployer for stability, since hardhat gives only one signer on remote nets.
    if (chainId !== 31337 && buyerAddr !== deployerAddr) {
        throw new Error(
            `On network(chainId=${chainId}), BUYER must equal deployer address.\n` +
            `- deployer: ${deployer.address}\n` +
            `- BUYER: ${buyerEnv}\n` +
            `If you need a different BUYER, run with that BUYER's PRIVATE_KEY configured in hardhat and make it the deployer.`
        );
    }

    // Local hardhat: allow impersonation if BUYER != deployer
    let buyerSigner = deployer;
    if (chainId === 31337 && buyerAddr !== deployerAddr) {
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [buyerEnv],
        });
        buyerSigner = await ethers.getSigner(buyerEnv);
    }

    console.log(`Network chainId=${chainId}`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Buyer:    ${await buyerSigner.getAddress()}`);
    console.log(`InterestVault: ${INTEREST_VAULT}`);
    console.log(`RewardToken:   ${REWARD_TOKEN}`);
    console.log(`TokenIds:      ${TOKEN_IDS.map((x) => x.toString()).join(", ")}`);
    console.log(`FundReward(human): ${fundRewardHuman}`);

    // Minimal ERC20 ABI with optional mint
    const erc20Abi = [
        "function decimals() view returns (uint8)",
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
        "function transfer(address,uint256) returns (bool)",
        "function mint(address,uint256)", // optional for MockUSDT
    ];

    // Minimal vault ABI (covers both claim signatures)
    const vaultAbi = [
        "function fund(uint256 amount)",
        "function claimable(uint256 tokenId, address account) view returns (uint256)",
        "function claim(uint256 tokenId)",
        "function claim(uint256 tokenId, address account)",
    ];

    const token = new ethers.Contract(REWARD_TOKEN, erc20Abi, buyerSigner);
    const vault = new ethers.Contract(INTEREST_VAULT, vaultAbi, buyerSigner);

    let decimals = 6;
    try {
        decimals = Number(await token.decimals());
    } catch (e) {
        // keep default 6
    }

    const fundAmount = ethers.parseUnits(fundRewardHuman, decimals);

    // Ensure buyer has enough token balance; try mint if possible
    const buyer = await buyerSigner.getAddress();
    let bal = await token.balanceOf(buyer);
    if (bal < fundAmount) {
        const need = fundAmount - bal;
        const minted = await tryMintIfPossible(token, buyer, need);
        if (!minted) {
            throw new Error(
                `Insufficient reward token balance for funding.\n` +
                `- buyer: ${buyer}\n` +
                `- balance: ${bal.toString()}\n` +
                `- required: ${fundAmount.toString()}\n` +
                `Token has no mint(). Ensure REWARD_TOKEN is MockUSDT deployed by scripts or transfer tokens to buyer.`
            );
        }
        bal = await token.balanceOf(buyer);
    }

    // Approve vault if needed
    const allowance = await token.allowance(buyer, INTEREST_VAULT);
    if (allowance < fundAmount) {
        const tx = await token.approve(INTEREST_VAULT, fundAmount);
        await tx.wait();
        console.log(`Approved vault: ${fundAmount.toString()}`);
    } else {
        console.log(`Approve skipped (allowance ok): ${allowance.toString()}`);
    }

    // Fund vault
    {
        const tx = await vault.fund(fundAmount);
        const receipt = await tx.wait();
        console.log(`Funded reward token: ${fundAmount.toString()} (tx=${receipt.hash})`);
    }

    // Claim for each tokenId (if claimable > 0)
    for (const tokenId of TOKEN_IDS) {
        let claimable = 0n;
        try {
            const v = await vault.claimable(tokenId, buyer);
            claimable = BigInt(v.toString());
        } catch (e) {
            console.log(
                `WARN: claimable(tokenId=${tokenId.toString()}, buyer=${buyer}) failed: ${e?.message || e}`
            );
            continue;
        }

        console.log(`claimable(tokenId=${tokenId.toString()}, buyer=${buyer}) = ${claimable.toString()}`);

        if (claimable === 0n) {
            console.log(`Skip claim (0 claimable) for tokenId=${tokenId.toString()}`);
            continue;
        }

        // Try claim(tokenId) first, then claim(tokenId,buyer) as fallback
        try {
            const tx = await vault.claim(tokenId);
            const receipt = await tx.wait();
            console.log(`Claimed (claim(uint256)) tokenId=${tokenId.toString()} tx=${receipt.hash}`);
        } catch (e1) {
            try {
                const tx = await vault.claim(tokenId, buyer);
                const receipt = await tx.wait();
                console.log(`Claimed (claim(uint256,address)) tokenId=${tokenId.toString()} tx=${receipt.hash}`);
            } catch (e2) {
                throw new Error(
                    `Claim failed for tokenId=${tokenId.toString()}.\n` +
                    `claim(uint256) error: ${e1?.message || e1}\n` +
                    `claim(uint256,address) error: ${e2?.message || e2}`
                );
            }
        }
    }

    console.log("Done.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
