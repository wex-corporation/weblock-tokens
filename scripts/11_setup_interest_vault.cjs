/* eslint-disable no-console */

/**
 * === Setup Interest Vault (per-second accrual) ===
 *
 * Purpose
 * - Deploy RBTInterestVault for a given RBTPropertyToken asset clone
 * - Wire the asset's `interestVault` so balances checkpoint on transfers
 * - Grant WFT MINTER_ROLE to the vault
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
    const WFT = process.env.WFT_ADDRESS
    const SERIES_ID = process.env.SERIES_ID || '1'
    const UNIT_PRICE_WEI = process.env.UNIT_PRICE_WEI || '1000000000000000000'
    const MULTIPLIER = process.env.RATE_MULTIPLIER || '100000'

    if (!ASSET || !WFT) {
        throw new Error(
            'Missing env: ASSET_ADDRESS and WFT_ADDRESS are required.'
        )
    }

    // Deploy vault
    const Vault = await ethers.getContractFactory('RBTInterestVault')
    const vault = await Vault.deploy(ASSET, WFT, deployer.address)
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

    // Grant WFT MINTER_ROLE
    const Wft = await ethers.getContractFactory('WFTToken')
    const wft = Wft.attach(WFT)
    const MINTER_ROLE = await wft.MINTER_ROLE()
    const has = await wft.hasRole(MINTER_ROLE, vaultAddress)
    if (!has) {
        console.log('grant MINTER_ROLE to vault on WFT...')
        await (await wft.grantRole(MINTER_ROLE, vaultAddress)).wait()
    } else {
        console.log('vault already has MINTER_ROLE on WFT')
    }

    console.log('\n=== Done ===')
    console.log(
        JSON.stringify(
            {
                chainId: Number(chainId),
                deployer: deployer.address,
                asset: ASSET,
                wft: WFT,
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
