// Создание пула на Uniswap V2 в Base и заведение в него ликвидности.
//
//   PRIVATE_KEY=0x... TOKEN_ADDRESS=0x... POOL_TOKENS=100 TARGET_PRICE_USD=0.001 \
//   CONFIRM=yes node scripts/add-liquidity.mjs
//
// Цена токена = отношение резервов в пуле, поэтому её задаёт пропорция вклада.
// Адреса роутера и фабрики не берутся на веру: скрипт сверяет их в сети до
// отправки чего-либо.
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
import { transportFor, endpointsFor } from './rpc.mjs'
import { waitUntil } from './wait.mjs'
import { describePlan, ethForTargetPrice, toWei } from './pool-plan.mjs'

// Официальные деплои Uniswap V2 в Base. Проверяются в сети ниже.
const DEFAULTS = {
  base: {
    router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    weth: '0x4200000000000000000000000000000000000006',
  },
}

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
  POOL_TOKENS = '100',
  TARGET_PRICE_USD = '0.001',
  ETH_USD = '3000',
  ROUTER,
  CONFIRM,
  SLIPPAGE_BPS = '100',
} = ENV

const key = normalizePrivateKey(PRIVATE_KEY)
if (key.error) fail(`ключ не подходит: ${key.error}`)
const parsedAddress = addressFrom({ argv: process.argv.slice(2), env: TOKEN_ADDRESS })
if (parsedAddress.error) fail(parsedAddress.error)

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}"`)

const defaults = DEFAULTS[CHAIN]
const routerAddress = ROUTER ?? defaults?.router
if (!routerAddress) fail(`для сети ${CHAIN} не задан ROUTER=0x... роутера Uniswap V2`)

const token = parsedAddress.address
const router = getAddress(routerAddress)
const account = privateKeyToAccount(key.key)
const transport = transportFor(chain, RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account, chain, transport })

const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
])
const FACTORY_ABI = parseAbi(['function getPair(address, address) view returns (address)'])
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
])

// ---------- проверка окружения до любых трат ----------
const routerCode = await publicClient.getCode({ address: router })
if (!routerCode || routerCode === '0x') fail(`по адресу роутера ${router} нет кода — не тот адрес или не та сеть`)

// Последовательно, а не пачкой: публичные RPC отвечают «over rate limit» на burst.
const factory = await publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'factory' })
const weth = await publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'WETH' })

if (defaults?.weth && getAddress(weth) !== getAddress(defaults.weth)) {
  fail(`роутер сообщает WETH ${weth}, а в сети ${CHAIN} ожидался ${defaults.weth} — проверь ROUTER`)
}

const symbol = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' })
const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
const balance = await publicClient.readContract({
  address: token,
  abi: ERC20_ABI,
  functionName: 'balanceOf',
  args: [account.address],
})

const existingPair = await publicClient.readContract({
  address: getAddress(factory),
  abi: FACTORY_ABI,
  functionName: 'getPair',
  args: [token, getAddress(weth)],
})

const pairExists = existingPair !== '0x0000000000000000000000000000000000000000'

// ---------- план ----------
const poolTokens = Number(POOL_TOKENS)
const ethUsd = Number(ETH_USD)
const targetPrice = Number(TARGET_PRICE_USD)
const balanceTokens = Number(formatUnits(balance, decimals))

const poolEth = ethForTargetPrice({ poolTokens, targetPriceUsd: targetPrice, ethUsd })
const plan = describePlan({ poolTokens, poolEth, balanceTokens, ethUsd })

const nativeBalance = await publicClient.getBalance({ address: account.address })
const nativeSymbol = chain.nativeCurrency.symbol

console.log(`сеть:      ${chain.name} (${chain.id})`)
console.log(`кошелёк:   ${account.address}`)
console.log(`баланс:    ${formatEther(nativeBalance)} ${nativeSymbol} и ${balanceTokens} ${symbol}`)
console.log(`узлы:      ${endpointsFor(chain, RPC_URL).length} (при отказе переключается на следующий)`)
console.log(`роутер:    ${router}`)
console.log(`фабрика:   ${getAddress(factory)}`)
console.log(`пара:      ${pairExists ? `уже существует, ${existingPair}` : 'будет создана'}`)

console.log(`\nв пул уйдёт:`)
console.log(`  ${poolTokens} ${symbol}`)
console.log(`  ${poolEth.toFixed(18).replace(/0+$/, '')} ${nativeSymbol}  (~$${(poolEth * ethUsd).toFixed(4)})`)

console.log(`\nчто получится:`)
console.log(`  цена токена       $${plan.priceUsd.toFixed(8)}  (курс ETH принят $${ethUsd})`)
console.log(`  ликвидность       ~$${plan.liquidityUsd.toFixed(2)}`)
console.log(`  останется у тебя  ${plan.remainingTokens} ${symbol}`)
console.log(`  покажет кошелёк   ~$${plan.displayedUsd.toFixed(2)}`)

console.log(`\nчестно про этот пул:`)
console.log(`  продажа ${plan.tokensToHalvePrice.toFixed(1)} ${symbol} уронит цену вдвое — ликвидности почти нет`)
console.log(`  пул публичный: любой может купить и потерять на этом деньги`)
console.log(`  вложенные ${(poolEth * ethUsd).toFixed(4)}$ из пула обратно так просто не достать`)
console.log(`  MetaMask цену из пула не читает — там останется прочерк`)

if (pairExists) {
  console.log(`\nпара уже есть: цену задаёт её текущий резерв, а не эта транзакция.`)
}

if (balance === 0n) fail(`\nна кошельке нет ${symbol} — нечего пулить`)

const amountTokenDesired = parseUnits(String(poolTokens), decimals)
if (amountTokenDesired > balance) fail(`\nнужно ${poolTokens} ${symbol}, а есть ${balanceTokens}`)

const amountEth = toWei(poolEth)
if (amountEth === 0n) fail('\nрасчётное количество ETH округлилось в ноль — увеличь POOL_TOKENS')

// ---------- подтверждение ----------
if (CONFIRM !== 'yes') fail('\nдля отправки нужен CONFIRM=yes')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question(`\nвведи тикер "${symbol}" для подтверждения: `)
rl.close()
if (answer.trim() !== symbol) fail('не совпало — отмена')

// ---------- approve ----------
const readAllowance = () =>
  publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, router],
  })

if ((await readAllowance()) < amountTokenDesired) {
  console.log('\nразрешаю роутеру списать токены...')
  const approveHash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [router, amountTokenDesired],
  })
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
  if (approveReceipt.status !== 'success') fail(`approve не прошёл: ${approveHash}`)
  console.log(`approve: ${approveHash}`)

  // Узлы в фолбэке расходятся на блок-два: следующий запрос может уйти на тот,
  // который approve ещё не видит, и роутер упадёт с TRANSFER_FROM_FAILED.
  process.stdout.write('жду, пока allowance увидят все узлы')
  await waitUntil({
    read: readAllowance,
    ok: (allowance) => allowance >= amountTokenDesired,
    attempts: 20,
    delayMs: 3000,
    onRetry: () => process.stdout.write('.'),
  }).catch((error) => fail(`\n${error.message}\n\napprove прошёл (${approveHash}), но сеть его ещё не отдаёт. Запусти скрипт снова.`))
  console.log(' готово')
} else {
  console.log('\napprove уже есть, пропускаю')
}

// ---------- добавление ликвидности ----------
const slippage = BigInt(SLIPPAGE_BPS)
const minToken = (amountTokenDesired * (10_000n - slippage)) / 10_000n
const minEth = (amountEth * (10_000n - slippage)) / 10_000n

// Дедлайн считаем от времени последнего блока, а не от локальных часов:
// разъехавшееся время на машине — обычная причина отказа роутера.
const block = await publicClient.getBlock()
const txDeadline = block.timestamp + 1200n

console.log('добавляю ликвидность...')

const liquidityCall = {
  address: router,
  abi: ROUTER_ABI,
  functionName: 'addLiquidityETH',
  args: [token, amountTokenDesired, minToken, minEth, account.address, txDeadline],
  value: amountEth,
  account,
}

// Симулируем отдельно, чтобы отказ роутера пришёл понятной строкой, а не стеком
// viem. Плюс терпим отстающий узел: он мог ещё не увидеть approve.
// waitUntil повторяет, пока read бросает, — успешная симуляция и есть результат.
await waitUntil({
  read: () => publicClient.simulateContract(liquidityCall),
  ok: () => true,
  attempts: 8,
  delayMs: 3000,
  onRetry: () => process.stdout.write('.'),
}).catch((error) => {
  const reason = /TRANSFER_FROM_FAILED/.test(error.message)
    ? 'роутер не смог списать токены: allowance ещё не виден сети. Запусти скрипт снова через минуту.'
    : error.message
  fail(`\nсимуляция не прошла — транзакция не отправлена, газ не потрачен.\n${reason}`)
})

const hash = await walletClient.writeContract(liquidityCall)
console.log(`tx: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') fail('транзакция не прошла')

const pair = await publicClient.readContract({
  address: getAddress(factory),
  abi: FACTORY_ABI,
  functionName: 'getPair',
  args: [token, getAddress(weth)],
})

console.log(`\nпул:       ${pair}`)
console.log(`газ:       ${receipt.gasUsed} (${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ${nativeSymbol})`)
if (chain.blockExplorers?.default) {
  console.log(`explorer:  ${chain.blockExplorers.default.url}/address/${pair}`)
}
console.log(`\nцена появится в Rabby, DexScreener и интерфейсе Uniswap — им хватает пула.`)
console.log(`В MetaMask по-прежнему прочерк: ему нужен листинг у агрегатора.`)
