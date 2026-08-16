// Запуск нового токена целиком, с вводом параметров в момент исполнения.
//
//   PRIVATE_KEY=0x... npm run launch
//
// Порядок:
//   1. спросить имя, тикер, decimals, эмиссию — и показать введённое побайтно
//   2. вывести ликвидность из старого пула, если она есть
//   3. задеплоить токен
//   4. обменять ETH на USDC
//   5. создать пару токен/USDC с ценой $1.00
//
// Параметры спрашиваются, а не берутся из окружения, ровно по одной причине:
// шелл раскрывает $$ в номер процесса, и "$$K.1" в двойных кавычках однажды
// уже уехал бы в мейннет как "11519K.1". В prompt ничего не раскрывается.
//
// Последовательность работы с пулами прогнана на локальном EVM против
// настоящего байткода Uniswap V2 — см. test/migrate.test.mjs.
import * as chains from 'viem/chains'
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createInterface } from 'node:readline/promises'
import { artifact } from '../test/harness.mjs'
import { normalizePrivateKey } from './key.mjs'
import { transportFor } from './rpc.mjs'
import { waitUntil } from './wait.mjs'
import { validateTokenParams, visible } from './token-params.mjs'

const BASE = {
  router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
  factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}
const OLD_TOKEN = '0x72883511A0B1dE1fF1cA0669D0C3dE699D56c0a8'
const ZERO = '0x0000000000000000000000000000000000000000'

const fail = (message) => {
  console.error(`\n${message}`)
  process.exit(1)
}

const { PRIVATE_KEY, RPC_URL, ETHERSCAN_API_KEY, POOL_TOKENS = '0.3', TARGET_PRICE_USD = '1' } = process.env

const key = normalizePrivateKey(PRIVATE_KEY)
if (key.error) fail(`ключ не подходит: ${key.error}`)

const chain = chains.base
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
])

const read = (address, abi, functionName, args) => publicClient.readContract({ address, abi, functionName, args })
const rl = createInterface({ input: process.stdin, output: process.stdout })

// Если ввод оборвался (скрипт запустили с пайпом или Ctrl-D), question() никогда
// не разрешится и процесс просто повиснет. Лучше сказать прямо.
let collecting = true
rl.on('close', () => {
  if (collecting) fail('ввод оборвался — скрипт рассчитан на запуск в терминале, а не через пайп')
})

const ask = async (question, fallback) => {
  const answer = (await rl.question(question)).trim()
  return answer === '' && fallback !== undefined ? fallback : answer
}

// ---------- 1. параметры ----------
// Спрашиваем до обращения к сети: заполнять форму, когда узел не отвечает,
// бессмысленно, а проверить ввод можно и без него.
console.log(`кошелёк: ${account.address}\n`)

let params
while (true) {
  const name = await ask('имя токена: ')
  const symbol = await ask('тикер: ')
  const decimals = await ask('decimals [18]: ', '18')
  const supply = await ask('эмиссия [1000000]: ', '1000000')

  const result = validateTokenParams({ name, symbol, decimals, supply })
  if (result.error) {
    console.log(`\n${result.error}\n`)
    continue
  }

  console.log(`\nимя:      ${visible(result.name)}`)
  console.log(`тикер:    ${visible(result.symbol)}`)
  console.log(`decimals: ${result.decimals}`)
  console.log(`эмиссия:  ${result.supply}`)
  for (const warning of result.warnings) console.log(`  ! ${warning}`)

  const confirm = await ask('\nвсё верно? имя пишется в контракт навсегда [да/нет]: ')
  if (/^(да|д|yes|y)$/i.test(confirm)) {
    params = result
    break
  }
  console.log('')
}

const supplyUnits = parseUnits(params.supply, params.decimals)
const poolTokens = parseUnits(POOL_TOKENS, params.decimals)
const targetPrice = Number(TARGET_PRICE_USD)
const poolUsdc = parseUnits((Number(POOL_TOKENS) * targetPrice).toFixed(6), 6)

if (poolTokens > supplyUnits) fail(`в пул нужно ${POOL_TOKENS}, а эмиссия всего ${params.supply}`)

// ---------- план ----------
const nativeBalance = await publicClient.getBalance({ address: account.address })
console.log(`\nбаланс: ${formatEther(nativeBalance)} ETH`)

const oldPair = await read(getAddress(BASE.factory), FACTORY, 'getPair', [
  getAddress(OLD_TOKEN),
  getAddress(BASE.weth),
])
let oldLp = 0n
if (oldPair !== ZERO) oldLp = await read(oldPair, PAIR, 'balanceOf', [account.address])

console.log(`\nчто будет сделано:`)
if (oldLp > 0n) console.log(`  1. вывод ликвидности из старого пула $$K.1/WETH (${oldPair})`)
console.log(`  ${oldLp > 0n ? 2 : 1}. деплой ${params.symbol}, эмиссия ${params.supply} -> тебе`)
console.log(`  ${oldLp > 0n ? 3 : 2}. обмен ETH на ${formatUnits(poolUsdc, 6)} USDC`)
console.log(`  ${oldLp > 0n ? 4 : 3}. пара ${params.symbol}/USDC: ${POOL_TOKENS} + ${formatUnits(poolUsdc, 6)} USDC = $${targetPrice.toFixed(2)}`)
console.log(`\nстарый токен $$K.1 никуда не денется — он останется в сети навсегда.`)
console.log(`Обеспечения у нового тоже нет: цена $${targetPrice.toFixed(2)} это пропорция в пуле, не привязка.`)

const go = await ask('\nотправлять транзакции? [да/нет]: ')
if (!/^(да|д|yes|y)$/i.test(go)) fail('отмена')
collecting = false
rl.close()

// ---------- отправка ----------
const deadline = async () => (await publicClient.getBlock()).timestamp + 1200n

const send = async (label, call) => {
  process.stdout.write(`${label}... `)
  await waitUntil({
    read: () => publicClient.simulateContract({ ...call, account }),
    ok: () => true,
    attempts: 8,
    delayMs: 3000,
    onRetry: () => process.stdout.write('.'),
  }).catch((error) => fail(`симуляция не прошла, транзакция не отправлена.\n${error.message}`))

  const hash = await walletClient.writeContract(call)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') fail(`${label}: транзакция не прошла, ${hash}`)
  console.log(`ок (${receipt.gasUsed} газа)`)
  return receipt
}

const approveTo = async (tokenAddress, amount, label) => {
  const current = await read(tokenAddress, ERC20, 'allowance', [account.address, getAddress(BASE.router)])
  if (current >= amount) return
  await send(label, {
    address: tokenAddress,
    abi: ERC20,
    functionName: 'approve',
    args: [getAddress(BASE.router), amount],
  })
  // Узлы в фолбэке расходятся на блок: без ожидания роутер упадёт с TRANSFER_FROM_FAILED.
  await waitUntil({
    read: () => read(tokenAddress, ERC20, 'allowance', [account.address, getAddress(BASE.router)]),
    ok: (value) => value >= amount,
    attempts: 20,
    delayMs: 3000,
  }).catch(() => fail('allowance не появился в сети — запусти скрипт снова, он продолжит с этого места'))
}

// 1. вывод старой ликвидности
if (oldLp > 0n) {
  await approveTo(oldPair, oldLp, 'approve LP старого пула')
  await send('вывод ликвидности', {
    address: getAddress(BASE.router),
    abi: ROUTER,
    functionName: 'removeLiquidityETH',
    args: [getAddress(OLD_TOKEN), oldLp, 0n, 0n, account.address, await deadline()],
  })
}

// 2. деплой
const { abi, bytecode } = artifact('FixedSupplyToken')
const args = [params.name, params.symbol, params.decimals, supplyUnits, account.address]

process.stdout.write('деплой токена... ')
const deployHash = await walletClient.deployContract({ abi, bytecode, args })
const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
if (deployReceipt.status !== 'success') fail(`деплой не прошёл: ${deployHash}`)
const token = getAddress(deployReceipt.contractAddress)
console.log(`ок`)
console.log(`\nновый токен: ${token}`)
console.log(`explorer:    https://basescan.org/token/${token}\n`)

// 3. USDC
const usdcBalance = await read(getAddress(BASE.usdc), ERC20, 'balanceOf', [account.address])
if (usdcBalance < poolUsdc) {
  const needed = poolUsdc - usdcBalance
  // Пул WETH/USDC глубже миллиона, проскальзывание на центах несущественно;
  // 20% запаса на движение цены между симуляцией и включением в блок.
  const ethIn = (needed * 12n * 10n ** 12n) / 10n
  await send(`обмен ETH на ${formatUnits(needed, 6)} USDC`, {
    address: getAddress(BASE.router),
    abi: ROUTER,
    functionName: 'swapExactETHForTokens',
    args: [needed, [getAddress(BASE.weth), getAddress(BASE.usdc)], account.address, await deadline()],
    value: ethIn,
  })
}

// 4. пара по $1.00
await approveTo(token, poolTokens, `approve ${params.symbol}`)
await approveTo(getAddress(BASE.usdc), poolUsdc, 'approve USDC')

await send('создание пары и ликвидность', {
  address: getAddress(BASE.router),
  abi: ROUTER,
  functionName: 'addLiquidity',
  args: [token, getAddress(BASE.usdc), poolTokens, poolUsdc, poolTokens, poolUsdc, account.address, await deadline()],
})

// ---------- результат ----------
const pair = await read(getAddress(BASE.factory), FACTORY, 'getPair', [token, getAddress(BASE.usdc)])
const [r0, r1] = await read(pair, PAIR, 'getReserves')
const token0 = await read(pair, PAIR, 'token0')
const tokenIsZero = getAddress(token0) === token
const finalToken = Number(formatUnits(tokenIsZero ? r0 : r1, params.decimals))
const finalUsdc = Number(formatUnits(tokenIsZero ? r1 : r0, 6))
const left = await publicClient.getBalance({ address: account.address })

console.log(`\n${'-'.repeat(60)}`)
console.log(`токен:    ${params.name} (${params.symbol})`)
console.log(`адрес:    ${token}`)
console.log(`пул:      ${pair}`)
console.log(`цена:     $${(finalUsdc / finalToken).toFixed(6)}`)
console.log(`глубина:  $${(finalUsdc * 2).toFixed(2)}`)
console.log(`осталось: ${formatEther(left)} ETH`)
console.log(`\nсмотреть: https://dexscreener.com/base/${pair}`)

console.log(`\nдальше:`)
console.log(`  верификация:  ETHERSCAN_API_KEY=... TOKEN_ADDRESS=${token} npm run verify`)
console.log(`  token list:   TOKEN_ADDRESS=${token} npm run token-list`)
if (!ETHERSCAN_API_KEY) console.log(`  (ключ Etherscan не задан, поэтому верификацию не запускаю сам)`)
