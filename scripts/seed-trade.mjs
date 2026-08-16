// Одна маленькая сделка, чтобы индексаторы увидели пару.
//
//   PRIVATE_KEY=0x... CONFIRM=yes node scripts/seed-trade.mjs 0xАДРЕС
//
// DexScreener и часть агрегаторов подхватывают пару только после первого свопа:
// наличие ликвидности им не повод. Задача — сделать этот своп настолько мелким,
// чтобы цена почти не сдвинулась.
//
// По умолчанию сдвиг ограничен 1%: размер сделки подбирается под лимит, а не
// задаётся руками. В пуле глубиной меньше доллара «куплю на копейку» легко
// оказывается покупкой на треть пула.
import * as chains from 'viem/chains'
import { createPublicClient, createWalletClient, formatEther, formatUnits, getAddress, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createInterface } from 'node:readline/promises'
import { normalizePrivateKey } from './key.mjs'
import { addressFrom } from './address.mjs'
import { transportFor } from './rpc.mjs'
import { waitUntil } from './wait.mjs'
import { impactOf, largestTradeWithin } from './trade-impact.mjs'

const BASE = {
  router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
  factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}
const ZERO = '0x0000000000000000000000000000000000000000'

const fail = (message) => {
  console.error(`\n${message}`)
  process.exit(1)
}

const { PRIVATE_KEY, RPC_URL, TOKEN_ADDRESS, MAX_IMPACT_BPS = '100', CONFIRM } = process.env

const key = normalizePrivateKey(PRIVATE_KEY)
if (key.error) fail(`ключ не подходит: ${key.error}`)

const parsed = addressFrom({ argv: process.argv.slice(2), env: TOKEN_ADDRESS })
if (parsed.error) fail(parsed.error)

const chain = chains.base
const token = parsed.address
const router = getAddress(BASE.router)
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
])
const ROUTER = parseAbi([
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[])',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
])
const WETH = getAddress('0x4200000000000000000000000000000000000006')

const read = (address, abi, functionName, args) => publicClient.readContract({ address, abi, functionName, args })

// ---------- состояние пула ----------
const symbol = await read(token, ERC20, 'symbol')
const decimals = Number(await read(token, ERC20, 'decimals'))

const pair = await read(getAddress(BASE.factory), FACTORY, 'getPair', [token, usdc])
if (pair === ZERO) fail(`пары ${symbol}/USDC не существует — сначала создай пул`)

const [r0, r1] = await read(pair, PAIR, 'getReserves')
const token0 = await read(pair, PAIR, 'token0')
const tokenIsZero = getAddress(token0) === token
const tokenReserve = tokenIsZero ? r0 : r1
const usdcReserve = tokenIsZero ? r1 : r0

const nativeBalance = await publicClient.getBalance({ address: account.address })

// ---------- размер сделки ----------
// Ограничение считается по пулу токен/USDC: первый хоп идёт через WETH/USDC
// глубиной больше миллиона, там влияние пренебрежимо.
const maxImpact = Number(MAX_IMPACT_BPS)
const usdcIn = largestTradeWithin({
  reserveIn: usdcReserve,
  reserveOut: tokenReserve,
  maxImpactBps: maxImpact,
})

if (usdcIn <= 0n) fail(`под лимит ${maxImpact} bps не влезает даже минимальная сделка`)

const impact = impactOf({ reserveIn: usdcReserve, reserveOut: tokenReserve, amountIn: usdcIn })

// Покупаем за ETH: USDC на кошельке не нужен, approve тоже — ETH его не требует.
const path = [WETH, usdc, token]
const ethIn = (await read(router, ROUTER, 'getAmountsIn', [usdcIn, [WETH, usdc]]))[0]
if (ethIn <= 0n) fail('роутер вернул нулевой вход — путь обмена не работает')

const expected = (await read(router, ROUTER, 'getAmountsOut', [ethIn, path]))[2]

const priceBefore = Number(formatUnits(usdcReserve, 6)) / Number(formatUnits(tokenReserve, decimals))
const priceAfter =
  Number(formatUnits(impact.reserveInAfter, 6)) / Number(formatUnits(impact.reserveOutAfter, decimals))

console.log(`пара:      ${pair}`)
console.log(`в пуле:    ${formatUnits(tokenReserve, decimals)} ${symbol} и ${formatUnits(usdcReserve, 6)} USDC`)
console.log(`цена:      $${priceBefore.toFixed(6)}`)
console.log(`ETH есть:  ${formatEther(nativeBalance)}`)

console.log(`\nсделка под лимит ${maxImpact} bps, путь WETH -> USDC -> ${symbol}:`)
console.log(`  вложить    ${formatEther(ethIn)} ETH  (~${formatUnits(usdcIn, 6)} USDC во втором хопе)`)
console.log(`  получить   ${formatUnits(expected, decimals)} ${symbol}`)
console.log(`  цена после $${priceAfter.toFixed(6)}  (сдвиг ${impact.impactBps} bps)`)
console.log(`\nпосле этого DexScreener подхватит пару — ему нужен факт сделки.`)

if (nativeBalance < ethIn * 2n) {
  fail(`ETH мало: нужно ${formatEther(ethIn)} плюс газ, есть ${formatEther(nativeBalance)}`)
}

if (CONFIRM !== 'yes') fail('для отправки нужен CONFIRM=yes')

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
  }).catch((error) => fail(`симуляция не прошла, транзакция не отправлена.\n${error.message}`))

  const hash = await walletClient.writeContract(call)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') fail(`${label}: транзакция не прошла, ${hash}`)
  console.log(`ок (${receipt.gasUsed} газа)`)
}

// Проскальзывание 10%: пул тонкий, между симуляцией и блоком цена может уехать,
// а суммы тут настолько мелкие, что терять нечего.
await send(`покупка ${symbol} за ETH`, {
  address: router,
  abi: ROUTER,
  functionName: 'swapExactETHForTokens',
  args: [(expected * 90n) / 100n, path, account.address, await deadline()],
  value: ethIn,
})

const [f0, f1] = await read(pair, PAIR, 'getReserves')
const finalToken = Number(formatUnits(tokenIsZero ? f0 : f1, decimals))
const finalUsdc = Number(formatUnits(tokenIsZero ? f1 : f0, 6))

console.log(`\nцена сейчас: $${(finalUsdc / finalToken).toFixed(6)}`)
console.log(`\nсмотреть:`)
console.log(`  https://dexscreener.com/base/${pair}`)
console.log(`  https://www.geckoterminal.com/base/pools/${pair}`)
console.log(`Индексаторам нужно несколько минут.`)
