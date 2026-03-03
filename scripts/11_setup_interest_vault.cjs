/* eslint-disable no-console */

/**
 * === Setup Interest Vault (per-second accrual) ===
 *
 * Purpose
 * - Deploy RBTInterestVault for a given RBTPropertyToken asset clone
 * - Wire the asset's `interestVault` so balances checkpoint on transfers
 * - Configure reward token (USDT on testnet)
 * - Configure series unit price (wei) and enable
 * - Optionally set a large `rateMultiplier` to accelerate accrual for testing
 */

const hre = require('hardhat')

async function main() {
    const { ethers } = hre

    const chainId = (await ethers.provider.getNetwork()).chainId
    console.log(`chainId: ${chainId}`)

    const [deployer] = await ethers.getSigners()
    console.log(`deployer: ${deployer.address}`)

    const ASSET = process.env.ASSET_ADDRESS
    const REWARD_TOKEN = process.env.REWARD_TOKEN_ADDRESS
    const SERIES_ID = process.env.SERIES_ID || '1'
    const UNIT_PRICE_WEI = process.env.UNIT_PRICE_WEI || '1000000000000000000'
    const MULTIPLIER = process.env.RATE_MULTIPLIER || '100000'

    if (!ASSET || !REWARD_TOKEN) {
        throw new Error('Missing env: ASSET_ADDRESS and REWARD_TOKEN_ADDRESS are required.')
    }

    // Deploy vault
    const Vault = await ethers.getContractFactory('RBTInterestVault')
    const vault = await Vault.deploy(ASSET, REWARD_TOKEN, deployer.address)
    await vault.waitForDeployment()
    const vaultAddress = await vault.getAddress()
    console.log(`RBTInterestVault: ${vaultAddress}`)

    // Configure series and accelerate
    console.log(`setSeriesConfig(tokenId=${SERIES_ID}, unitPriceWei=${UNIT_PRICE_WEI})`)
    await (await vault.configureSeries(SERIES_ID, UNIT_PRICE_WEI, true)).wait()
    console.log(`setRateMultiplier(${MULTIPLIER})`)
    await (await vault.setRateMultiplier(MULTIPLIER)).wait()

    // Wire asset
    const Asset = await ethers.getContractFactory('RBTPropertyToken')
    const asset = Asset.attach(ASSET)
    console.log(`setInterestVault(${vaultAddress}) on asset...`)
    await (await asset.setInterestVault(vaultAddress)).wait()

    console.log('\n=== Done ===')
    console.log(
        JSON.stringify(
            {
                chainId: Number(chainId),
                deployer: deployer.address,
                asset: ASSET,
                rewardToken: REWARD_TOKEN,
                interestVault: vaultAddress,
                seriesId: String(SERIES_ID),
                unitPriceWei: String(UNIT_PRICE_WEI),
                rateMultiplier: String(MULTIPLIER),
            },
            null,
            2
        )
    )
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
