// Подгон цены пула до целевой одной покупкой.
//
//   PRIVATE_KEY=0x... TOKEN_ADDRESS=0x... TARGET_PRICE_USD=0.001 CONFIRM=yes \
//   node scripts/nudge-price.mjs
//
// Курс ETH берётся из GeckoTerminal, а не зашивается: именно на устаревшем
// курсе прошлый расчёт разошёлся с целью в 1.6 раза.
import * as chains from 'viem/chains'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createInterface } from 'node:readline/promises'
import { normalizePrivateKey } from './key.mjs'
import { readEnv } from './env.mjs'
import { transportFor } from './rpc.mjs'
import { waitUntil } from './wait.mjs'
import { ethInForTargetPrice, priceAfterSwap } from './swap-plan.mjs'

const ROUTERS = {
  base: { router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', weth: '0x4200000000000000000000000000000000000006' },
}

const GECKO = 'https://api.geckoterminal.com/api/v2/networks'
const GECKO_NETWORK = { 8453: 'base', 10: 'optimism', 42161: 'arbitrum', 1: 'eth' }

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

// Синонимы принимаются, непонятные имена — отказ: молча взятый дефолт хуже.
const ENV = readEnv(process.env, fail)

const {
  PRIVATE_KEY,
  TOKEN_ADDRESS,
  CHAIN = 'base',
  RPC_URL,
  TARGET_PRICE_USD = '0.001',
  ETH_USD,
  ROUTER,
  CONFIRM,
  SLIPPAGE_BPS = '300',
} = ENV

const key = normalizePrivateKey(PRIVATE_KEY)
if (key.error) fail(`ключ не подходит: ${key.error}`)
if (!TOKEN_ADDRESS || !isAddress(TOKEN_ADDRESS)) fail('нужен TOKEN_ADDRESS=0x... — адрес токена')

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}"`)

const defaults = ROUTERS[CHAIN]
const routerAddress = ROUTER ?? defaults?.router
if (!routerAddress) fail(`для сети ${CHAIN} задай ROUTER=0x... роутера Uniswap V2`)

const token = getAddress(TOKEN_ADDRESS)
const router = getAddress(routerAddress)
const account = privateKeyToAccount(key.key)
const transport = transportFor(chain, RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account, chain, transport })

const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
])
const FACTORY_ABI = parseAbi(['function getPair(address, address) view returns (address)'])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])

// ---------- состояние пула ----------
const factory = await publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'factory' })
const weth = await publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'WETH' })

const pair = await publicClient.readContract({
  address: getAddress(factory),
  abi: FACTORY_ABI,
  functionName: 'getPair',
  args: [token, getAddress(weth)],
})

if (pair === '0x0000000000000000000000000000000000000000') {
  fail(`пула ${token}/WETH не существует — сначала создай его: npm run pool`)
}

const symbol = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' })
const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
const reserves = await publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' })
const token0 = await publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })

const tokenIsZero = getAddress(token0) === token
const tokenReserveRaw = tokenIsZero ? reserves[0] : reserves[1]
const wethReserveRaw = tokenIsZero ? reserves[1] : reserves[0]

const tokenReserve = Number(formatUnits(tokenReserveRaw, decimals))
const wethReserve = Number(formatEther(wethReserveRaw))

// ---------- курс ETH ----------
let ethUsd = ETH_USD ? Number(ETH_USD) : null
let ethUsdSource = 'задан вручную'

if (!ethUsd) {
  const network = GECKO_NETWORK[chain.id]
  const response = await fetch(`${GECKO}/${network}/pools/${pair}`).catch(() => null)
  const body = await response?.json().catch(() => null)
  ethUsd = Number(body?.data?.attributes?.quote_token_price_usd)
  ethUsdSource = 'GeckoTerminal'

  if (!ethUsd || !Number.isFinite(ethUsd)) {
    fail('не удалось получить курс ETH — передай ETH_USD=<курс> вручную')
  }
}

// ---------- план ----------
const targetUsd = Number(TARGET_PRICE_USD)
const targetPriceEth = targetUsd / ethUsd
const currentPriceEth = wethReserve / tokenReserve

const ethIn = (() => {
  try {
    return ethInForTargetPrice({ wethReserve, tokenReserve, targetPrice: targetPriceEth })
  } catch (error) {
    fail(`\n${error.message}`)
  }
})()

const after = priceAfterSwap({ wethReserve, tokenReserve, ethIn })
const balance = await publicClient.readContract({
  address: token,
  abi: ERC20_ABI,
  functionName: 'balanceOf',
  args: [account.address],
})
const balanceTokens = Number(formatUnits(balance, decimals))
const nativeBalance = await publicClient.getBalance({ address: account.address })
const nativeSymbol = chain.nativeCurrency.symbol

console.log(`сеть:      ${chain.name} (${chain.id})`)
console.log(`пул:       ${pair}`)
console.log(`курс ETH:  $${ethUsd} (${ethUsdSource})`)
console.log(`\nв пуле сейчас:`)
console.log(`  ${tokenReserve} ${symbol} и ${wethReserve} ${nativeSymbol}`)
console.log(`  цена ${(currentPriceEth * ethUsd).toFixed(8)} $`)

console.log(`\nпокупка ${ethIn.toFixed(12)} ${nativeSymbol} (~$${(ethIn * ethUsd).toFixed(4)}):`)
console.log(`  получишь          ${after.tokensOut.toFixed(4)} ${symbol}`)
console.log(`  цена станет       $${(after.price * ethUsd).toFixed(8)}  (цель $${targetUsd})`)
console.log(`  ликвидность       ~$${(after.wethReserve * ethUsd * 2).toFixed(2)}`)
console.log(`  твой баланс       ${(balanceTokens + after.tokensOut).toFixed(2)} ${symbol}`)
console.log(`  покажет как       ~$${((balanceTokens + after.tokensOut) * after.price * ethUsd).toFixed(2)}`)
console.log(`\nсделка также заставит DexScreener проиндексировать пару.`)

if (nativeBalance < BigInt(Math.ceil(ethIn * 1e18))) {
  fail(`\nнужно ${ethIn} ${nativeSymbol}, а на балансе ${formatEther(nativeBalance)}`)
}

if (CONFIRM !== 'yes') fail('\nдля отправки нужен CONFIRM=yes')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question(`\nвведи тикер "${symbol}" для подтверждения: `)
rl.close()
if (answer.trim() !== symbol) fail('не совпало — отмена')

// ---------- своп ----------
const amountIn = BigInt(Math.floor(ethIn * 1e18))
const expectedOut = BigInt(Math.floor(after.tokensOut * 10 ** Number(decimals)))
const slippage = BigInt(SLIPPAGE_BPS)
const amountOutMin = (expectedOut * (10_000n - slippage)) / 10_000n

const block = await publicClient.getBlock()
const swapCall = {
  address: router,
  abi: ROUTER_ABI,
  functionName: 'swapExactETHForTokens',
  args: [amountOutMin, [getAddress(weth), token], account.address, block.timestamp + 1200n],
  value: amountIn,
  account,
}

process.stdout.write('\nпроверяю симуляцией')
await waitUntil({
  read: () => publicClient.simulateContract(swapCall),
  ok: () => true,
  attempts: 6,
  delayMs: 3000,
  onRetry: () => process.stdout.write('.'),
}).catch((error) => fail(`\nсимуляция не прошла — транзакция не отправлена, газ не потрачен.\n${error.message}`))
console.log(' ок')

const hash = await walletClient.writeContract(swapCall)
console.log(`tx: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') fail('транзакция не прошла')

// ---------- что получилось ----------
const finalReserves = await publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' })
const finalToken = Number(formatUnits(tokenIsZero ? finalReserves[0] : finalReserves[1], decimals))
const finalWeth = Number(formatEther(tokenIsZero ? finalReserves[1] : finalReserves[0]))
const finalPrice = (finalWeth / finalToken) * ethUsd

console.log(`\nгаз:       ${receipt.gasUsed} (${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ${nativeSymbol})`)
console.log(`цена:      $${finalPrice.toFixed(8)}`)
console.log(`\nсмотреть здесь:`)
console.log(`  https://www.geckoterminal.com/${GECKO_NETWORK[chain.id]}/pools/${pair}`)
console.log(`  https://dexscreener.com/${GECKO_NETWORK[chain.id]}/${pair}`)
