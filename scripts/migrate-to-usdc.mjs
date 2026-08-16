// Перевод цены токена на $1.00 через новую пару с USDC.
//
//   PRIVATE_KEY=0x... TOKEN_ADDRESS=0x... CONFIRM=yes node scripts/migrate-to-usdc.mjs
//
// ЗАЧЕМ ТАК. Поднять цену в существующей паре с WETH покупкой стоит ~$1.95:
// цена растёт как квадрат прироста ETH в пуле. А в НОВОЙ паре начальная цена
// задаётся пропорцией вклада, поэтому $1.00 получается точно и почти бесплатно.
//
// Последовательность целиком прогнана на локальном EVM против настоящего
// байткода Uniswap V2 — см. test/migrate.test.mjs.
//
// ЧЕСТНО О РЕЗУЛЬТАТЕ: это оформление, а не стейблкоин. Обеспечения нет,
// обменять токен на доллар нельзя, глубина пула останется меньше доллара.
// Цифра $1.00 держится до первой заметной продажи.
import * as chains from 'viem/chains'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createInterface } from 'node:readline/promises'
import { normalizePrivateKey } from './key.mjs'
import { addressFrom } from './address.mjs'
import { readEnv } from './env.mjs'
import { transportFor } from './rpc.mjs'
import { waitUntil } from './wait.mjs'
import { quoteExactBuy, EXACT_SWAP_ABI } from './swap.mjs'

const BASE = {
  router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
  factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const ENV = readEnv(process.env, fail)
const {
  PRIVATE_KEY,
  TOKEN_ADDRESS,
  CHAIN = 'base',
  RPC_URL,
  POOL_TOKENS = '0.3',
  TARGET_PRICE_USD = '1',
  CONFIRM,
} = ENV

const key = normalizePrivateKey(PRIVATE_KEY)
if (key.error) fail(`ключ не подходит: ${key.error}`)
const parsedAddress = addressFrom({ argv: process.argv.slice(2), env: TOKEN_ADDRESS })
if (parsedAddress.error) fail(parsedAddress.error)
if (CHAIN !== 'base') fail('скрипт написан под Base: адреса роутера, фабрики и USDC зашиты для неё')

const chain = chains[CHAIN]
const token = parsedAddress.address
const router = getAddress(BASE.router)
const factory = getAddress(BASE.factory)
const weth = getAddress(BASE.weth)
const usdc = getAddress(BASE.usdc)

const account = privateKeyToAccount(key.key)
const transport = transportFor(chain, RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account, chain, transport })

const ERC20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
])
const FACTORY = parseAbi(['function getPair(address, address) view returns (address)'])
const PAIR = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
])
const ROUTER = parseAbi([
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256, uint256)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)',
  ...EXACT_SWAP_ABI,
])

const read = (address, abi, functionName, args) =>
  publicClient.readContract({ address, abi, functionName, args })

const ZERO = '0x0000000000000000000000000000000000000000'

// ---------- состояние ----------
const symbol = await read(token, ERC20, 'symbol')
const decimals = await read(token, ERC20, 'decimals')
const tokenBalance = await read(token, ERC20, 'balanceOf', [account.address])
const nativeBalance = await publicClient.getBalance({ address: account.address })

const wethPair = await read(factory, FACTORY, 'getPair', [token, weth])
const usdcPair = await read(factory, FACTORY, 'getPair', [token, usdc])

const targetPrice = Number(TARGET_PRICE_USD)
const poolTokens = parseUnits(POOL_TOKENS, Number(decimals))
const poolUsdc = parseUnits((Number(POOL_TOKENS) * targetPrice).toFixed(6), 6)

console.log(`сеть:      ${chain.name}`)
console.log(`кошелёк:   ${account.address}`)
console.log(`баланс:    ${formatEther(nativeBalance)} ETH и ${formatUnits(tokenBalance, Number(decimals))} ${symbol}`)
console.log(`пара WETH: ${wethPair === ZERO ? 'нет' : wethPair}`)
console.log(`пара USDC: ${usdcPair === ZERO ? 'нет, будет создана' : `уже есть: ${usdcPair}`}`)

if (usdcPair !== ZERO) {
  fail(
    `\nПара ${symbol}/USDC уже существует. Первая ликвидность задаёт цену только\n` +
      `в новой паре; в существующей цену определяют её резервы. Тогда нужен nudge:\n` +
      `  TARGET_PRICE_USD=${targetPrice} npm run nudge`,
  )
}

let lp = 0n
if (wethPair !== ZERO) {
  lp = await read(wethPair, PAIR, 'balanceOf', [account.address])
  const [r0, r1] = await read(wethPair, PAIR, 'getReserves')
  const token0 = await read(wethPair, PAIR, 'token0')
  const tokenIsZero = getAddress(token0) === token
  const ethSide = tokenIsZero ? r1 : r0
  console.log(`\nв паре WETH сейчас ${formatEther(ethSide)} ETH — вывод вернёт их тебе`)
}

console.log(`\nплан:`)
console.log(`  1. вывести ликвидность из ${symbol}/WETH${lp === 0n ? ' (нечего, LP нет)' : ''}`)
console.log(`  2. обменять ETH на ${formatUnits(poolUsdc, 6)} USDC`)
console.log(`  3. создать пару ${symbol}/USDC: ${formatUnits(poolTokens, Number(decimals))} ${symbol} + ${formatUnits(poolUsdc, 6)} USDC`)
console.log(`\nитог: цена ровно $${targetPrice.toFixed(2)}, остаток ${formatUnits(tokenBalance - poolTokens, Number(decimals))} ${symbol}`)
console.log(`      номинально это ~$${(Number(formatUnits(tokenBalance - poolTokens, Number(decimals))) * targetPrice).toFixed(0)}`)

console.log(`\nчестно:`)
console.log(`  обеспечения нет, обменять токен на доллар нельзя — это не стейблкоин`)
console.log(`  глубина новой пары будет ~$${(Number(formatUnits(poolUsdc, 6)) * 2).toFixed(2)}`)
console.log(`  старая пара с WETH останется видна с почти нулевой ликвидностью`)

if (tokenBalance < poolTokens) fail(`\nнужно ${POOL_TOKENS} ${symbol}, а есть ${formatUnits(tokenBalance, Number(decimals))}`)
if (CONFIRM !== 'yes') fail('\nдля отправки нужен CONFIRM=yes')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question(`\nвведи тикер "${symbol}" для подтверждения: `)
rl.close()
if (answer.trim() !== symbol) fail('не совпало — отмена')

const deadline = async () => (await publicClient.getBlock()).timestamp + 1200n
const send = async (label, call) => {
  process.stdout.write(`${label}... `)
  await waitUntil({
    read: () => publicClient.simulateContract({ ...call, account }),
    ok: () => true,
    attempts: 8,
    delayMs: 3000,
    onRetry: () => process.stdout.write('.'),
  }).catch((error) => fail(`\nсимуляция не прошла, транзакция не отправлена.\n${error.message}`))

  const hash = await walletClient.writeContract(call)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') fail(`\n${label}: транзакция не прошла, ${hash}`)
  console.log(`ок, ${receipt.gasUsed} газа`)
  return receipt
}

const approveIfNeeded = async (tokenAddress, amount, label) => {
  const allowance = await read(tokenAddress, ERC20, 'allowance', [account.address, router])
  if (allowance >= amount) return
  await send(label, { address: tokenAddress, abi: ERC20, functionName: 'approve', args: [router, amount] })
  await waitUntil({
    read: () => read(tokenAddress, ERC20, 'allowance', [account.address, router]),
    ok: (value) => value >= amount,
    attempts: 20,
    delayMs: 3000,
  }).catch(() => fail('allowance не появился в сети — запусти скрипт снова'))
}

// ---------- 1. вывод ликвидности ----------
if (lp > 0n) {
  const pairAllowance = await read(wethPair, ERC20, 'allowance', [account.address, router])
  if (pairAllowance < lp) {
    await send('approve LP', { address: wethPair, abi: PAIR, functionName: 'approve', args: [router, lp] })
    await waitUntil({
      read: () => read(wethPair, ERC20, 'allowance', [account.address, router]),
      ok: (value) => value >= lp,
      attempts: 20,
      delayMs: 3000,
    }).catch(() => fail('allowance на LP не появился — запусти снова'))
  }

  await send('вывод ликвидности', {
    address: router,
    abi: ROUTER,
    functionName: 'removeLiquidityETH',
    args: [token, lp, 0n, 0n, account.address, await deadline()],
  })
}

// ---------- 2. ETH -> USDC ----------
const usdcBalance = await read(usdc, ERC20, 'balanceOf', [account.address])
if (usdcBalance < poolUsdc) {
  const needed = poolUsdc - usdcBalance
  const path = [weth, usdc]

  // Нужный ETH считает роутер: попытка вывести его из курса руками стоила нам
  // запроса в 1882 раза больше нужного и падения с OutOfFunds.
  const { required, value } = await quoteExactBuy({
    publicClient,
    router,
    abi: ROUTER,
    path,
    amountOut: needed,
  })

  console.log(`нужно ${formatEther(required)} ETH за ${formatUnits(needed, 6)} USDC`)
  if (nativeBalance < value) fail(`не хватает ETH: нужно ~${formatEther(value)}, есть ${formatEther(nativeBalance)}`)

  await send(`обмен ETH на ${formatUnits(needed, 6)} USDC`, {
    address: router,
    abi: ROUTER,
    functionName: 'swapETHForExactTokens',
    args: [needed, path, account.address, await deadline()],
    value,
  })
}

// ---------- 3. новая пара ----------
await approveIfNeeded(token, poolTokens, `approve ${symbol}`)
await approveIfNeeded(usdc, poolUsdc, 'approve USDC')

await send('создание пары и ликвидность', {
  address: router,
  abi: ROUTER,
  functionName: 'addLiquidity',
  args: [token, usdc, poolTokens, poolUsdc, poolTokens, poolUsdc, account.address, await deadline()],
})

// ---------- результат ----------
// Узлы в фолбэке расходятся на блок: getPair сразу после создания пары может
// вернуть ноль. Транзакции уже прошли, падать на выводе итога нельзя.
const newPair = await waitUntil({
  read: () => read(factory, FACTORY, 'getPair', [token, usdc]),
  ok: (address) => address && address !== ZERO,
  attempts: 20,
  delayMs: 3000,
  onRetry: () => process.stdout.write('.'),
}).catch(() => null)

if (!newPair) {
  console.log(`\nВсе транзакции прошли, но адрес пары сеть пока не отдаёт — узел отстал.`)
  console.log(`Пул создан, посмотри через минуту: https://basescan.org/token/${token}`)
  process.exit(0)
}

const [nr0, nr1] = await read(newPair, PAIR, 'getReserves')
const nToken0 = await read(newPair, PAIR, 'token0')
const tokenIsZero = getAddress(nToken0) === token
const finalToken = Number(formatUnits(tokenIsZero ? nr0 : nr1, Number(decimals)))
const finalUsdc = Number(formatUnits(tokenIsZero ? nr1 : nr0, 6))

console.log(`\nпара:      ${newPair}`)
console.log(`цена:      $${(finalUsdc / finalToken).toFixed(6)}`)
console.log(`глубина:   $${(finalUsdc * 2).toFixed(2)}`)
console.log(`\nсмотреть:`)
console.log(`  https://dexscreener.com/base/${newPair}`)
console.log(`  https://www.geckoterminal.com/base/pools/${newPair}`)
console.log(`\nDexScreener подхватит пару после первой сделки.`)
