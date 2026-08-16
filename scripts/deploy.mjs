// Деплой токена. Ничего не делает без явных переменных окружения.
//
//   PRIVATE_KEY=0x... TOKEN_NAME="..." TOKEN_SYMBOL=... npm run deploy
//
// По умолчанию — Base Sepolia (тестовая сеть). Для мейннета нужен ещё CONFIRM=yes.
import { createWalletClient, createPublicClient, parseUnits, formatEther, formatUnits, encodeDeployData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { createInterface } from 'node:readline/promises'
import { artifact } from '../test/harness.mjs'
import { transportFor } from './rpc.mjs'
import { normalizePrivateKey } from './key.mjs'

const {
  PRIVATE_KEY,
  RPC_URL,
  CHAIN = 'baseSepolia',
  TOKEN_NAME = '$$K.1',
  TOKEN_SYMBOL = '$$K.1',
  TOKEN_DECIMALS = '18',
  TOKEN_SUPPLY = '1000000',
  HOLDER,
  CONFIRM,
} = process.env

const TESTNETS = new Set(['sepolia', 'baseSepolia', 'arbitrumSepolia', 'optimismSepolia', 'polygonAmoy', 'holesky'])

function fail(message) {
  console.error(message)
  process.exit(1)
}

const parsedKey = normalizePrivateKey(PRIVATE_KEY)
if (parsedKey.error) {
  fail(
    `ключ не подходит: ${parsedKey.error}\n\n` +
      'Нужен приватный ключ аккаунта: MetaMask -> ⋮ -> Account details -> Show private key.\n' +
      'Это 64 символа 0-9/a-f; префикс 0x можно не писать, скрипт допишет сам.',
  )
}

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}". Имя берётся из viem/chains: mainnet, base, arbitrum, baseSepolia, ...`)

const isTestnet = TESTNETS.has(CHAIN) || chain.testnet === true
const decimals = Number(TOKEN_DECIMALS)
const supply = parseUnits(TOKEN_SUPPLY, decimals)

const account = privateKeyToAccount(parsedKey.key)
const transport = transportFor(chain, RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account, chain, transport })
const holder = HOLDER ?? account.address

const { abi, bytecode } = artifact('FixedSupplyToken')
const args = [TOKEN_NAME, TOKEN_SYMBOL, decimals, supply, holder]

const balance = await publicClient.getBalance({ address: account.address })
const symbol = chain.nativeCurrency.symbol

console.log(`сеть:     ${chain.name} (chainId ${chain.id})${isTestnet ? ' — тестовая' : ''}`)
console.log(`деплоер:  ${account.address}`)
console.log(`баланс:   ${formatEther(balance)} ${symbol}`)
console.log(`токен:    "${TOKEN_NAME}" / ${TOKEN_SYMBOL}, ${decimals} decimals`)
console.log(`эмиссия:  ${formatUnits(supply, decimals)} ${TOKEN_SYMBOL} -> ${holder}`)

if (balance === 0n) fail(`\nна балансе ноль ${symbol} — платить за газ нечем`)

// Оценка стоимости до отправки: деплой необратим, цену надо видеть заранее.
// Для деплоя оцениваем через estimateGas с calldata конструктора: у транзакции
// создания контракта нет ни адреса, ни функции, поэтому estimateContractGas тут не подходит.
const deployData = encodeDeployData({ abi, bytecode, args })
const gas = await publicClient.estimateGas({ account, data: deployData })
const { maxFeePerGas, gasPrice } = await publicClient.estimateFeesPerGas().catch(() => ({}))
const price = maxFeePerGas ?? gasPrice ?? (await publicClient.getGasPrice())
const cost = gas * price

console.log(`\nгаз:      ${gas} x ${formatUnits(price, 9)} gwei = ~${formatEther(cost)} ${symbol}`)

if (cost > balance) fail(`не хватает на газ: нужно ~${formatEther(cost)} ${symbol}, есть ${formatEther(balance)}`)

if (!isTestnet) {
  console.log(`\n  Это мейннет. Транзакция необратима, деньги настоящие.`)
  console.log(`  Контракт нельзя будет изменить или удалить, эмиссию — допечатать.`)

  if (CONFIRM !== 'yes') fail('\nдля мейннета нужен CONFIRM=yes в переменных окружения')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\nвведи тикер "${TOKEN_SYMBOL}" для подтверждения: `)
  rl.close()
  if (answer.trim() !== TOKEN_SYMBOL) fail('не совпало — отмена')
}

console.log('\nотправляю...')
const hash = await walletClient.deployContract({ abi, bytecode, args })
console.log(`tx: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') fail('транзакция прошла, но контракт не задеплоился')

console.log(`\nконтракт:  ${receipt.contractAddress}`)
console.log(`газ:       ${receipt.gasUsed} (${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ${symbol})`)
if (chain.blockExplorers?.default) {
  console.log(`explorer:  ${chain.blockExplorers.default.url}/address/${receipt.contractAddress}`)
}
console.log(`\nдальше: верификация исходников, см. README`)
