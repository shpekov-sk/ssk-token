import test from 'node:test'
import assert from 'node:assert/strict'
import { ethInForTargetPrice, priceAfterSwap, getAmountOut } from '../scripts/swap-plan.mjs'

// Реальное состояние пула $$K.1/WETH после создания.
const POOL = { wethReserve: 0.000033333333333333, tokenReserve: 100 }
const ETH_USD = 1878.01

test('расчёт попадает в целевую цену — главное свойство', () => {
  const target = 0.001 / ETH_USD
  const ethIn = ethInForTargetPrice({ ...POOL, targetPrice: target })
  const after = priceAfterSwap({ ...POOL, ethIn })

  assert.ok(Math.abs(after.price / target - 1) < 1e-9, `цена после свопа ${after.price}, цель ${target}`)
})

test('на живых числах выходит около 0.0000088 ETH', () => {
  const ethIn = ethInForTargetPrice({ ...POOL, targetPrice: 0.001 / ETH_USD })

  assert.ok(ethIn > 8.5e-6 && ethIn < 9.2e-6, `неожиданная сумма: ${ethIn}`)
  assert.ok(ethIn * ETH_USD < 0.02, `дороже двух центов: $${ethIn * ETH_USD}`)
})

test('цена растёт как квадрат прироста ETH в пуле', () => {
  // Удвоение цены требует прироста ETH в sqrt(2) раз, а не в два.
  const target = (POOL.wethReserve / POOL.tokenReserve) * 2
  const ethIn = ethInForTargetPrice({ ...POOL, targetPrice: target })
  const ratio = (POOL.wethReserve + ethIn) / POOL.wethReserve

  assert.ok(Math.abs(ratio - Math.SQRT2) < 0.01, `прирост ${ratio}, ожидался ~1.414`)
})

test('чем выше цель, тем больше нужно ETH', () => {
  const base = POOL.wethReserve / POOL.tokenReserve
  const amounts = [1.5, 2, 5, 10].map((k) => ethInForTargetPrice({ ...POOL, targetPrice: base * k }))

  for (let i = 1; i < amounts.length; i++) {
    assert.ok(amounts[i] > amounts[i - 1], 'зависимость должна быть монотонной')
  }
})

test('цель ниже текущей цены отбивается с объяснением', () => {
  const current = POOL.wethReserve / POOL.tokenReserve

  assert.throws(() => ethInForTargetPrice({ ...POOL, targetPrice: current * 0.5 }), /только поднять/)
  assert.throws(() => ethInForTargetPrice({ ...POOL, targetPrice: current }), /только поднять/)
})

test('пустой пул — понятная ошибка, а не NaN', () => {
  assert.throws(() => ethInForTargetPrice({ wethReserve: 0, tokenReserve: 100, targetPrice: 1e-6 }), /нет резервов/)
  assert.throws(() => ethInForTargetPrice({ wethReserve: 1, tokenReserve: 0, targetPrice: 1e-6 }), /нет резервов/)
})

test('комиссия учитывается: без неё ETH нужно было бы меньше', () => {
  const target = 0.001 / ETH_USD
  const withFee = ethInForTargetPrice({ ...POOL, targetPrice: target, feeBps: 30 })
  const noFee = ethInForTargetPrice({ ...POOL, targetPrice: target, feeBps: 0 })

  assert.ok(withFee > noFee, 'комиссия должна удорожать сдвиг цены')
})

test('getAmountOut совпадает с формулой UniswapV2Library', () => {
  // Известный пример: 1000 в пул с резервами 1e6 / 1e6.
  const out = getAmountOut({ amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n })

  // amountInWithFee = 997000; out = 997000*1e6 / (1e6*1e4 + 997000) = 996
  assert.equal(out, 996n)
})

test('getAmountOut отбивает нулевой ввод и пустые резервы', () => {
  assert.throws(() => getAmountOut({ amountIn: 0n, reserveIn: 1n, reserveOut: 1n }), /amountIn/)
  assert.throws(() => getAmountOut({ amountIn: 1n, reserveIn: 0n, reserveOut: 1n }), /резервов/)
})

test('после свопа токенов в пуле меньше, а ETH больше', () => {
  const ethIn = ethInForTargetPrice({ ...POOL, targetPrice: 0.001 / ETH_USD })
  const after = priceAfterSwap({ ...POOL, ethIn })

  assert.ok(after.tokenReserve < POOL.tokenReserve)
  assert.ok(after.wethReserve > POOL.wethReserve)
  assert.ok(after.tokensOut > 0)
})
