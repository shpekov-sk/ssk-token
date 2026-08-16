import test from 'node:test'
import assert from 'node:assert/strict'
import { foldChain, optimalCycle, runChain, cycleProfit } from '../scripts/arb/cycle.mjs'

const E = (n) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n
const hop = (reserveIn, reserveOut, feeBps = 30n) => ({ reserveIn, reserveOut, feeBps })

test('свёртка одного хопа — это он сам', () => {
  const single = hop(E(100), E(200))
  const folded = foldChain([single])

  assert.equal(folded.A, single.reserveIn)
  assert.equal(folded.B, single.reserveOut)
})

test('ГЛАВНОЕ: свёртка двух хопов даёт тот же выход, что и прогон по очереди', () => {
  const hops = [hop(E(100), E(200)), hop(E(150), E(300))]
  const folded = foldChain(hops)

  for (const amount of [E(0.01), E(0.1), E(1), E(5)]) {
    const direct = runChain(amount, hops)
    const viaFold = runChain(amount, [hop(folded.A, folded.B, folded.feeBps)])

    // Расхождение только от целочисленного округления — доли процента.
    const diff = direct > viaFold ? direct - viaFold : viaFold - direct
    assert.ok(diff * 10_000n < direct, `свёртка разошлась на ${diff} при вводе ${amount}`)
  }
})

test('свёртка трёх хопов тоже совпадает с прогоном', () => {
  const hops = [hop(E(100), E(200)), hop(E(200), E(50)), hop(E(50), E(120))]
  const folded = foldChain(hops)
  const amount = E(0.5)

  const direct = runChain(amount, hops)
  const viaFold = runChain(amount, [hop(folded.A, folded.B, folded.feeBps)])
  const diff = direct > viaFold ? direct - viaFold : viaFold - direct

  assert.ok(diff * 1_000n < direct, `расхождение ${diff} слишком велико`)
})

test('оптимум цикла действительно максимум', () => {
  // Цикл с явным перекосом: обратно возвращается больше, чем вложено.
  const hops = [hop(E(100), E(200)), hop(E(200), E(400)), hop(E(380), E(105))]
  const result = optimalCycle(hops)

  assert.equal(result.viable, true, result.reason)
  assert.ok(result.profit > 0n)

  const step = result.amountIn / 50n
  for (let i = -25n; i <= 25n; i++) {
    const candidate = result.amountIn + i * step
    if (candidate <= 0n) continue
    assert.ok(
      cycleProfit(candidate, hops) <= result.profit,
      `размер ${candidate} прибыльнее оптимума`,
    )
  }
})

test('сбалансированный цикл невыгоден: комиссии съедают круг', () => {
  // Курсы согласованы, перекоса нет.
  const hops = [hop(E(100), E(200)), hop(E(200), E(400)), hop(E(400), E(100))]
  const result = optimalCycle(hops)

  assert.equal(result.viable, false)
  assert.match(result.reason, /меньше вложенного/)
})

test('цикл из трёх хопов должен перебить 0.9% комиссий', () => {
  // Перекос 0.5% — меньше суммы комиссий, значит невыгодно.
  const small = optimalCycle([hop(E(100), E(200)), hop(E(200), E(400)), hop(E(400), E(100.5))])
  assert.equal(small.viable, false, 'перекос 0.5% не должен проходить')

  // Перекос 2% — проходит.
  const big = optimalCycle([hop(E(100), E(200)), hop(E(200), E(400)), hop(E(400), E(102))])
  assert.equal(big.viable, true, 'перекос 2% обязан проходить')
})

test('прибыль ограничена глубиной самого тонкого хопа', () => {
  const deep = optimalCycle([hop(E(1000), E(2000)), hop(E(2000), E(4000)), hop(E(3800), E(1050))])
  const shallow = optimalCycle([hop(E(1), E(2)), hop(E(2), E(4)), hop(E(3.8), E(1.05))])

  assert.ok(deep.viable && shallow.viable)
  assert.ok(deep.profit > shallow.profit * 100n, 'глубина должна масштабировать прибыль')
})

test('пустой пул в цепочке не роняет расчёт', () => {
  const result = optimalCycle([hop(E(100), E(200)), hop(0n, E(400)), hop(E(400), E(100))])

  assert.equal(result.viable, false)
  assert.match(result.reason, /пустой пул/)
})

test('пустая цепочка отбивается явно', () => {
  assert.throws(() => foldChain([]), /пустая цепочка/)
})

test('нулевой ввод даёт нулевой выход, а не ошибку', () => {
  assert.equal(runChain(0n, [hop(E(100), E(200))]), 0n)
})
