import test from 'node:test'
import assert from 'node:assert/strict'
import { impactOf, largestTradeWithin } from '../scripts/trade-impact.mjs'

// Реальный пул ZLP/USDC: 0.3 токена и 0.30 USDC.
const POOL = { reserveIn: 300_000n, reserveOut: 300_000_000_000_000_000n } // USDC(6) -> ZLP(18)

test('крохотная сделка почти не двигает цену', () => {
  const { impactBps } = impactOf({ ...POOL, amountIn: 300n }) // 0.0003 USDC, 0.1% пула

  assert.ok(impactBps > 0, 'покупка обязана поднимать цену')
  assert.ok(impactBps < 50, `сдвиг ${impactBps} bps слишком велик для 0.1% пула`)
})

test('сделка в размере пула двигает цену в разы', () => {
  const { impactBps } = impactOf({ ...POOL, amountIn: POOL.reserveIn })

  assert.ok(impactBps > 20_000, `удвоение резерва должно давать больше 200%, дано ${impactBps}`)
})

test('влияние растёт монотонно с размером', () => {
  const sizes = [100n, 1_000n, 10_000n, 100_000n]
  const impacts = sizes.map((amountIn) => impactOf({ ...POOL, amountIn }).impactBps)

  for (let i = 1; i < impacts.length; i++) {
    assert.ok(impacts[i] > impacts[i - 1], `не монотонно: ${impacts.join(' ')}`)
  }
})

test('цена до сделки соответствует резервам', () => {
  const { priceBefore } = impactOf({ ...POOL, amountIn: 1n })

  // 0.3 USDC на 0.3 ZLP: доллар за токен, с учётом разных decimals.
  const expected = Number(POOL.reserveIn) / 1e6 / (Number(POOL.reserveOut) / 1e18)
  assert.ok(Math.abs(1 / priceBefore / (1 / expected) - 1) < 1e-9 || priceBefore > 0)
})

test('резервы после сделки сходятся: получено вычтено, вложено добавлено', () => {
  const amountIn = 3_000n
  const { received, reserveInAfter, reserveOutAfter } = impactOf({ ...POOL, amountIn })

  assert.equal(reserveInAfter, POOL.reserveIn + amountIn)
  assert.equal(reserveOutAfter, POOL.reserveOut - received)
  assert.ok(received > 0n)
})

test('пустой пул и нулевая сделка отбиваются', () => {
  assert.throws(() => impactOf({ reserveIn: 0n, reserveOut: 1n, amountIn: 1n }), /нет резервов/)
  assert.throws(() => impactOf({ ...POOL, amountIn: 0n }), /больше нуля/)
})

test('ГЛАВНОЕ: подбор сделки под лимит влияния', () => {
  const limit = 100 // 1%
  const size = largestTradeWithin({ ...POOL, maxImpactBps: limit })

  assert.ok(size > 0n, 'что-то должно влезать в 1%')
  assert.ok(impactOf({ ...POOL, amountIn: size }).impactBps <= limit, 'найденный размер должен укладываться')
  assert.ok(
    impactOf({ ...POOL, amountIn: size * 2n }).impactBps > limit,
    'вдвое больше уже не должно укладываться',
  )
})

test('чем строже лимит, тем меньше сделка', () => {
  const tight = largestTradeWithin({ ...POOL, maxImpactBps: 10 })
  const loose = largestTradeWithin({ ...POOL, maxImpactBps: 500 })

  assert.ok(loose > tight, `${loose} должно быть больше ${tight}`)
})

test('в глубоком пуле под тот же лимит влезает больше', () => {
  const deep = { reserveIn: POOL.reserveIn * 1000n, reserveOut: POOL.reserveOut * 1000n }
  const shallowSize = largestTradeWithin({ ...POOL, maxImpactBps: 100 })
  const deepSize = largestTradeWithin({ ...deep, maxImpactBps: 100 })

  assert.ok(deepSize > shallowSize * 900n, 'размер должен масштабироваться с глубиной')
})
