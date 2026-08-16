import test from 'node:test'
import assert from 'node:assert/strict'
import { optimalArb, profitOf, amountOut, isqrt, netProfit } from '../scripts/arb/optimal.mjs'

const E = (n) => BigInt(n) * 10n ** 18n

// Пул 1 дешевле: за 1 A дают больше B, чем во втором.
const SPREAD = { a1: E(100), b1: E(210), a2: E(100), b2: E(190) }

test('целочисленный корень точен на границах', () => {
  assert.equal(isqrt(0n), 0n)
  assert.equal(isqrt(1n), 1n)
  assert.equal(isqrt(3n), 1n)
  assert.equal(isqrt(4n), 2n)
  assert.equal(isqrt(10n ** 36n), 10n ** 18n)
  assert.throws(() => isqrt(-1n), /отрицательного/)
})

test('корень согласован: isqrt(n)^2 <= n < (isqrt(n)+1)^2', () => {
  for (const n of [2n, 15n, 16n, 17n, 12345678901234567890n, E(7) * E(3)]) {
    const r = isqrt(n)
    assert.ok(r * r <= n, `${r}^2 > ${n}`)
    assert.ok((r + 1n) * (r + 1n) > n, `(${r}+1)^2 <= ${n}`)
  }
})

test('ГЛАВНОЕ: формула действительно даёт максимум прибыли', () => {
  const { amountIn, profit } = optimalArb(SPREAD)

  // Перебираем окрестность оптимума с мелким шагом: ничто не должно быть лучше.
  const step = amountIn / 100n
  for (let i = -50n; i <= 50n; i++) {
    const candidate = amountIn + i * step
    if (candidate <= 0n) continue
    assert.ok(
      profitOf(candidate, SPREAD) <= profit,
      `размер ${candidate} прибыльнее оптимума: ${profitOf(candidate, SPREAD)} > ${profit}`,
    )
  }
})

test('оптимум лучше и грубого сканирования всего диапазона', () => {
  const { amountIn, profit } = optimalArb(SPREAD)

  let best = 0n
  for (let i = 1n; i <= 200n; i++) {
    const candidate = (SPREAD.a1 * i) / 200n
    const p = profitOf(candidate, SPREAD)
    if (p > best) best = p
  }

  assert.ok(profit >= best, `скан нашёл больше: ${best} против ${profit}`)
  assert.ok(amountIn > 0n)
})

test('прибыль положительна и это не крохи', () => {
  const { profit } = optimalArb(SPREAD)

  assert.ok(profit > 0n)
  // Спред 210/190 ~ 10%, на резервах по 100 должно набегать заметно.
  assert.ok(profit > E(1) / 10n, `слишком мало: ${profit}`)
})

test('одинаковые пулы — арбитража нет', () => {
  const result = optimalArb({ a1: E(100), b1: E(200), a2: E(100), b2: E(200) })

  assert.equal(result.viable, false)
  assert.match(result.reason, /двойной комиссии/)
  assert.equal(result.amountIn, 0n)
})

test('спред меньше двойной комиссии не отбивается', () => {
  // 0.3% в каждом пуле — нужно больше ~0.6% разницы.
  const tiny = optimalArb({ a1: E(100), b1: E(2005), a2: E(100), b2: E(2000) })

  assert.equal(tiny.viable, false, 'спред 0.25% не должен быть выгоден')
})

test('спред чуть больше двойной комиссии уже выгоден', () => {
  const enough = optimalArb({ a1: E(100), b1: E(2030), a2: E(100), b2: E(2000) })

  assert.equal(enough.viable, true, 'спред 1.5% обязан проходить')
  assert.ok(enough.profit > 0n)
})

test('направление имеет значение: обратный арбитраж невыгоден', () => {
  const forward = optimalArb(SPREAD)
  const backward = optimalArb({ a1: SPREAD.a2, b1: SPREAD.b2, a2: SPREAD.a1, b2: SPREAD.b1 })

  assert.equal(forward.viable, true)
  assert.equal(backward.viable, false, 'покупать в дорогом пуле не может быть выгодно')
})

test('пустые резервы обрабатываются, а не роняют', () => {
  assert.equal(optimalArb({ a1: 0n, b1: E(1), a2: E(1), b2: E(1) }).viable, false)
  assert.equal(optimalArb({ a1: E(1), b1: E(1), a2: E(1), b2: 0n }).reason, 'пустые резервы')
})

test('нулевая комиссия увеличивает и прибыль, и размер сделки', () => {
  const withFee = optimalArb({ ...SPREAD, feeBps: 30n })
  const noFee = optimalArb({ ...SPREAD, feeBps: 0n })

  assert.ok(noFee.profit > withFee.profit)
  assert.ok(noFee.amountIn > withFee.amountIn)
})

test('чем глубже пулы, тем больше абсолютная прибыль при том же спреде', () => {
  const shallow = optimalArb({ a1: E(10), b1: E(21), a2: E(10), b2: E(19) })
  const deep = optimalArb({ a1: E(1000), b1: E(2100), a2: E(1000), b2: E(1900) })

  assert.ok(deep.profit > shallow.profit * 50n, 'прибыль должна масштабироваться с глубиной')
})

test('газ решает: та же сделка выгодна или нет в зависимости от цены газа', () => {
  const { amountIn } = optimalArb(SPREAD)
  const pools = SPREAD

  const cheap = netProfit({ amountIn, pools, gasUnits: 250_000n, gasPriceWei: 20_000_000n })
  const expensive = netProfit({ amountIn, pools, gasUnits: 250_000n, gasPriceWei: 10n ** 13n })

  assert.ok(cheap > 0n, 'на дешёвом газе должно оставаться в плюсе')
  assert.ok(expensive < 0n, 'на дорогом — уходить в минус')
})

test('комиссия флеш-займа вычитается из прибыли', () => {
  const { amountIn } = optimalArb(SPREAD)
  const free = netProfit({ amountIn, pools: SPREAD, gasUnits: 0n, gasPriceWei: 0n, flashFeeBps: 0n })
  const aave = netProfit({ amountIn, pools: SPREAD, gasUnits: 0n, gasPriceWei: 0n, flashFeeBps: 5n })

  assert.ok(aave < free)
  assert.equal(free - aave, (amountIn * 5n) / 10_000n)
})

test('amountOut совпадает с эталоном UniswapV2Library', () => {
  assert.equal(amountOut(1000n, 1_000_000n, 1_000_000n), 996n)
  assert.equal(amountOut(0n, 1n, 1n), 0n)
  assert.equal(amountOut(100n, 0n, 1n), 0n, 'пустой резерв не должен ронять')
})
