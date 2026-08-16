import test from 'node:test'
import assert from 'node:assert/strict'
import { ethForTargetPrice, tokensForTargetPrice, describePlan, toWei } from '../scripts/pool-plan.mjs'

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`)

test('ETH под целевую цену: $0.001 за токен при 100 токенах', () => {
  const eth = ethForTargetPrice({ poolTokens: 100, targetPriceUsd: 0.001, ethUsd: 3000 })

  // 100 токенов по $0.001 = $0.10, это 0.10/3000 ETH.
  close(eth, 0.1 / 3000)
})

test('обратный счёт согласован с прямым', () => {
  const eth = ethForTargetPrice({ poolTokens: 100, targetPriceUsd: 0.001, ethUsd: 3000 })
  const tokens = tokensForTargetPrice({ poolEth: eth, targetPriceUsd: 0.001, ethUsd: 3000 })

  close(tokens, 100, 1e-6)
})

test('цена — это отношение резервов, и она даёт нужную картинку в кошельке', () => {
  const plan = describePlan({
    poolTokens: 100,
    poolEth: 0.1 / 3000,
    balanceTokens: 1_000_000,
    ethUsd: 3000,
  })

  close(plan.priceUsd, 0.001, 1e-12)
  assert.equal(plan.remainingTokens, 999_900)
  close(plan.displayedUsd, 999.9, 1e-6)
})

test('ликвидность считается по обеим сторонам пула', () => {
  const plan = describePlan({ poolTokens: 100, poolEth: 0.1 / 3000, balanceTokens: 1_000_000, ethUsd: 3000 })
  close(plan.liquidityUsd, 0.2, 1e-9)
})

test('показывает, насколько пул тонкий: сколько токенов роняет цену вдвое', () => {
  const plan = describePlan({ poolTokens: 100, poolEth: 0.001, balanceTokens: 1_000_000, ethUsd: 3000 })

  // x = T*(sqrt(2)-1) ~ 41.4% от резерва.
  close(plan.tokensToHalvePrice, 41.421356237, 1e-6)
})

test('нельзя запулить больше, чем есть на балансе', () => {
  assert.throws(
    () => describePlan({ poolTokens: 2_000_000, poolEth: 0.001, balanceTokens: 1_000_000, ethUsd: 3000 }),
    /на балансе/,
  )
})

test('нулевые и отрицательные параметры отбиваются', () => {
  assert.throws(() => ethForTargetPrice({ poolTokens: 0, targetPriceUsd: 0.001, ethUsd: 3000 }), /poolTokens/)
  assert.throws(() => ethForTargetPrice({ poolTokens: 100, targetPriceUsd: 0, ethUsd: 3000 }), /targetPriceUsd/)
  assert.throws(() => ethForTargetPrice({ poolTokens: 100, targetPriceUsd: 0.001, ethUsd: 0 }), /ethUsd/)
})

test('toWei не теряет точность на мелких дробях', () => {
  assert.equal(toWei(1), 10n ** 18n)
  assert.equal(toWei(0.5), 5n * 10n ** 17n)
  assert.equal(toWei(0.1 / 3000), 33333333333333n)
})
