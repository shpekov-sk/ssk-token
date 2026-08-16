// Поиск пар Uniswap V2 с балансом сверх учтённых резервов.
//
//   node scripts/arb/skim.mjs [сколько пар проверить]
//
// Такой излишек появляется, когда токены переводят прямо на адрес пары, минуя
// роутер. Отправитель их уже не вернёт: `skim(address)` разрешает забрать
// разницу любому желающему, а любой своп или `sync()` втянет её в резервы.
//
// ЗАЧЕМ ЭТО ЗДЕСЬ. Замер от 2026-08-16 по 300 парам, равномерно взятым из
// 3 043 518: излишков ноль. Причина не в редкости ошибочных переводов, а в том,
// что окно между переводом и следующим касанием пары — секунды, и его закрывают
// боты, слушающие события Transfer на адреса пар. Скрипт оставлен, чтобы этот
// вывод можно было перепроверить, а не принимать на слово.
import * as chains from 'viem/chains'
import { createPublicClient, getAddress, parseAbi, formatUnits } from 'viem'
import { transportFor } from '../rpc.mjs'

const { CHAIN = 'base', RPC_URL } = process.env
const SAMPLE = Number(process.argv[2] ?? 300)

const FACTORIES = { base: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' }

const chain = chains[CHAIN]
if (!chain) {
  console.error(`неизвестная сеть "${CHAIN}"`)
  process.exit(1)
}
const factory = FACTORIES[CHAIN]
if (!factory) {
  console.error(`для сети ${CHAIN} не задана проверенная фабрика Uniswap V2`)
  process.exit(1)
}

const client = createPublicClient({ chain, transport: transportFor(chain, RPC_URL), batch: { multicall: false } })

const FACTORY_ABI = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
])
const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

const total = await client.readContract({ address: getAddress(factory), abi: FACTORY_ABI, functionName: 'allPairsLength' })
console.log(`пар в фабрике: ${total}`)
console.log(`проверяю: ${SAMPLE} равномерной сеткой\n`)

// Равномерная сетка вместо случайности: результат воспроизводим.
const indices = Array.from({ length: SAMPLE }, (_, i) => (BigInt(i) * total) / BigInt(SAMPLE))

let checked = 0
const found = []

for (const index of indices) {
  const pair = await client
    .readContract({ address: getAddress(factory), abi: FACTORY_ABI, functionName: 'allPairs', args: [index] })
    .catch(() => null)
  if (!pair) continue

  const [token0, token1, reserves] = await Promise.all([
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }).catch(() => null),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token1' }).catch(() => null),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' }).catch(() => null),
  ])
  if (!token0 || !token1 || !reserves) continue

  const [balance0, balance1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [pair] }).catch(() => 0n),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [pair] }).catch(() => 0n),
  ])

  checked++
  const excess0 = balance0 > reserves[0] ? balance0 - reserves[0] : 0n
  const excess1 = balance1 > reserves[1] ? balance1 - reserves[1] : 0n

  if (excess0 > 0n || excess1 > 0n) {
    found.push({ pair, token0, token1, excess0, excess1 })
    console.log(`НАЙДЕНО ${pair}`)
    if (excess0 > 0n) console.log(`  token0 ${token0}: излишек ${excess0}`)
    if (excess1 > 0n) console.log(`  token1 ${token1}: излишек ${excess1}`)
  }

  if (checked % 50 === 0) process.stdout.write(`.`)
}

console.log(`\n\nпроверено: ${checked}`)
console.log(`с излишком: ${found.length} (${((found.length / Math.max(checked, 1)) * 100).toFixed(2)}%)`)

if (!found.length) {
  console.log(`\nИзлишков нет. Окно между ошибочным переводом и следующим касанием`)
  console.log(`пары закрывают боты, слушающие Transfer на адреса пар.`)
} else {
  console.log(`\nПрежде чем вызывать skim: излишек должен перебить газ (~$0.005 в Base),`)
  console.log(`а токен — иметь ликвидность, иначе забранное некуда продать.`)
}
