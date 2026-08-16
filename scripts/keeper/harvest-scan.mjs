// Сколько на самом деле платят за вызов harvest() в вейтах Beefy.
//
//   node scripts/keeper/harvest-scan.mjs [сколько вейтов]
//
// ЗАЧЕМ. У стратегий Beefy есть view-функция callReward(), заявляющая награду
// вызывающему. Замер от 2026-08-16 на Base: она завышает **в ~4700 раз**.
// Настоящую выплату видно только трассировкой — это перевод WETH на адрес
// вызывающего внутри harvest().
//
// Коэффициент завышения одинаков (4701-4703x) на всех проверенных вейтах, то
// есть это систематическая ошибка формулы или конфига комиссий, а не разброс.
// Практический вывод: харвест на Base окупается примерно на 12% — вызывать его
// в убыток. Скрипт оставлен, чтобы вывод можно было перепроверить.
//
// Нужен узел с debug_traceCall: публичные его в основном не дают.
// Проверено на base.drpc.org (бесплатный тариф, с таймаутами).
import { formatEther } from 'viem'

const {
  TRACE_RPC = 'https://base.drpc.org',
  CALLER = '0x0cf1430E31B264a262aFF5fBA4D577daB5660A2a',
  ETH_USD = '1882',
  GAS_PRICE_GWEI = '0.006',
} = process.env

const LIMIT = Number(process.argv[2] ?? 10)
const WETH = '0x4200000000000000000000000000000000000006'
const TRANSFER = '0xa9059cbb'
const CALL_REWARD = '0x97fd323d'
const HARVEST = '0x4641257d'

const ethUsd = Number(ETH_USD)
const gasPriceEth = Number(GAS_PRICE_GWEI) * 1e-9

async function rpc(method, params, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(TRACE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const body = await response.json()
      if (!body.error) return body.result
    } catch {}
    await new Promise((done) => setTimeout(done, 1500))
  }
  return null
}

/** Суммарный перевод токена на адрес вызывающего внутри вызова. */
function feeFromTrace(trace, caller) {
  const flat = []
  const walk = (call) => {
    if (!call) return
    flat.push(call)
    for (const inner of call.calls ?? []) walk(inner)
  }
  walk(trace)

  const target = caller.toLowerCase().slice(2)
  let total = 0n
  const tokens = new Set()

  for (const call of flat) {
    const input = call.input ?? ''
    if (!input.startsWith(TRANSFER)) continue
    if (input.slice(34, 74).toLowerCase() !== target) continue
    total += BigInt(`0x${input.slice(74, 138)}`)
    tokens.add((call.to ?? '').toLowerCase())
  }

  return { total, tokens: [...tokens], internalCalls: flat.length }
}

const vaults = (await (await fetch('https://api.beefy.finance/vaults')).json()).filter(
  (vault) => vault.chain === 'base' && vault.status === 'active' && vault.strategy,
)

console.log(`активных вейтов Base: ${vaults.length}`)
console.log(`проверяю: ${LIMIT}`)
console.log(`цена газа: ${GAS_PRICE_GWEI} gwei, ETH принят $${ethUsd}\n`)

const usd = (wei) => Number(formatEther(wei)) * ethUsd
const rows = []

for (const vault of vaults.slice(0, LIMIT)) {
  const claimedRaw = await rpc('eth_call', [{ to: vault.strategy, data: CALL_REWARD }, 'latest'])
  if (!claimedRaw || claimedRaw === '0x') continue

  const gasRaw = await rpc('eth_estimateGas', [{ from: CALLER, to: vault.strategy, data: HARVEST }])
  const trace = await rpc('debug_traceCall', [
    { from: CALLER, to: vault.strategy, data: HARVEST },
    'latest',
    { tracer: 'callTracer' },
  ])

  if (!trace) {
    console.log(`${vault.id}: трассировка недоступна — узел не даёт debug_traceCall`)
    continue
  }

  const claimed = BigInt(claimedRaw)
  const { total: actual, tokens } = feeFromTrace(trace, CALLER)
  const gasUnits = gasRaw ? BigInt(gasRaw) : 0n
  const gasEth = Number(gasUnits) * gasPriceEth
  const net = usd(actual) - gasEth * ethUsd

  rows.push({ id: vault.id, claimed, actual, gasUnits, net, tokens })

  console.log(
    `${vault.id.slice(0, 38).padEnd(38)} ` +
      `обещано $${usd(claimed).toFixed(4).padStart(9)}  ` +
      `реально $${usd(actual).toFixed(4).padStart(7)}  ` +
      `газ $${(gasEth * ethUsd).toFixed(4)}  ` +
      `итог $${net.toFixed(4).padStart(8)}` +
      (actual > 0n ? `  завышение ${Math.round(Number(claimed) / Number(actual))}x` : ''),
  )
}

const profitable = rows.filter((row) => row.net > 0)

console.log(`\nпроверено: ${rows.length}`)
console.log(`в плюсе после газа: ${profitable.length}`)

if (!profitable.length && rows.length) {
  const worst = rows.reduce((acc, row) => (row.net < acc.net ? row : acc))
  console.log(`\nВсе в минусе. Хуже всего ${worst.id}: ${worst.net.toFixed(4)}$ за вызов.`)
  console.log(`callReward() доверять нельзя — единственный надёжный источник это трассировка.`)
  console.log(`Плата приходит в WETH (${WETH}), а не в нативном ETH.`)
}
