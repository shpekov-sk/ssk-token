// Сканер арбитража между пулами constant product в реальной сети.
//
//   node scripts/arb/scan.mjs
//
// Считает по замкнутой формуле оптимальный размер сделки и — главное —
// прибыль ПОСЛЕ газа. До газа положительных возможностей на порядок больше,
// чем после, поэтому единственное честное число тут последнее.
import * as chains from 'viem/chains'
import { createPublicClient, getAddress, parseAbi, formatUnits } from 'viem'
import { transportFor } from '../rpc.mjs'
import { optimalArb, netProfit } from './optimal.mjs'

const { CHAIN = 'base', RPC_URL, GAS_UNITS = '250000' } = process.env

const chain = chains[CHAIN]
if (!chain) {
  console.error(`неизвестная сеть "${CHAIN}"`)
  process.exit(1)
}

const client = createPublicClient({ chain, transport: transportFor(chain, RPC_URL) })

const FACTORY_ABI = parseAbi(['function getPair(address, address) view returns (address)'])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
])
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

// Только те фабрики, которые реально отвечают в этой сети. Непроверенные адреса
// молча возвращают ноль, поэтому каждая проверяется наличием кода.
const VENUES = {
  base: [{ name: 'uniswap-v2', factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', feeBps: 30n }],
}

const TOKENS = {
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  },
}

const venues = VENUES[CHAIN] ?? []
const tokens = TOKENS[CHAIN] ?? {}

if (!venues.length) {
  console.error(`для сети ${CHAIN} не задано ни одной проверенной фабрики`)
  process.exit(1)
}

/** Резервы пары на конкретной площадке, приведённые к порядку (base, quote). */
async function readPair(venue, baseToken, quoteToken) {
  const factoryCode = await client.getCode({ address: getAddress(venue.factory) })
  if (!factoryCode || factoryCode === '0x') return null

  const pair = await client.readContract({
    address: getAddress(venue.factory),
    abi: FACTORY_ABI,
    functionName: 'getPair',
    args: [getAddress(baseToken), getAddress(quoteToken)],
  })
  if (pair === '0x0000000000000000000000000000000000000000') return null

  const reserves = await client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' })
  const token0 = await client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })

  const baseIsZero = getAddress(token0) === getAddress(baseToken)
  return {
    venue: venue.name,
    feeBps: venue.feeBps,
    pair,
    base: baseIsZero ? reserves[0] : reserves[1],
    quote: baseIsZero ? reserves[1] : reserves[0],
  }
}

const gasPrice = await client.getGasPrice()
const gasUnits = BigInt(GAS_UNITS)

console.log(`сеть:  ${chain.name}`)
console.log(`газ:   ${formatUnits(gasPrice, 9)} gwei x ${gasUnits} = ${formatUnits(gasUnits * gasPrice, 18)} ETH`)
console.log(`площадок в списке: ${venues.length}\n`)

if (venues.length < 2) {
  console.log('Для арбитража нужно минимум две площадки с одной парой.')
  console.log('В списке одна проверенная — остальные адреса фабрик не подтверждены в сети,')
  console.log('а гадать адресами в скрипте, который тратит деньги, нельзя.\n')
}

const pairs = [
  ['WETH', 'USDC'],
  ['WETH', 'DAI'],
  ['cbBTC', 'WETH'],
]

for (const [baseName, quoteName] of pairs) {
  const baseToken = tokens[baseName]
  const quoteToken = tokens[quoteName]
  if (!baseToken || !quoteToken) continue

  const quotes = []
  for (const venue of venues) {
    const data = await readPair(venue, baseToken, quoteToken).catch(() => null)
    if (data && data.base > 0n && data.quote > 0n) quotes.push(data)
  }

  if (!quotes.length) {
    console.log(`${baseName}/${quoteName}: пулов не нашлось`)
    continue
  }

  const decimals = await client.readContract({ address: getAddress(quoteToken), abi: ERC20_ABI, functionName: 'decimals' })

  console.log(`${baseName}/${quoteName}`)
  for (const quote of quotes) {
    const price = Number(quote.quote) / Number(quote.base) * 10 ** (18 - Number(decimals))
    console.log(`  ${quote.venue.padEnd(14)} цена ${price.toFixed(4)}  пул ${quote.pair}`)
  }

  // Перебираем все упорядоченные пары площадок: направление важно.
  let found = 0
  for (const buy of quotes) {
    for (const sell of quotes) {
      if (buy === sell) continue

      const result = optimalArb({ a1: buy.quote, b1: buy.base, a2: sell.base, b2: sell.quote, feeBps: buy.feeBps })
      if (!result.viable) continue

      const net = netProfit({
        amountIn: result.amountIn,
        pools: { a1: buy.quote, b1: buy.base, a2: sell.base, b2: sell.quote, feeBps: buy.feeBps },
        gasUnits,
        gasPriceWei: gasPrice,
      })

      found++
      console.log(`  ${buy.venue} -> ${sell.venue}: вход ${formatUnits(result.amountIn, Number(decimals))}`)
      console.log(`     грязными ${formatUnits(result.profit, Number(decimals))}, после газа ${formatUnits(net, Number(decimals))}`)
    }
  }

  if (!found) console.log(`  возможностей нет: спред меньше суммы комиссий\n`)
  else console.log('')
}
