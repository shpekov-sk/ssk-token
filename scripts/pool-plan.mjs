// Расчёт параметров пула: сколько ETH положить рядом с токенами, чтобы получить
// нужную цену, и что из этого выйдет.
//
// Цена в AMM — это отношение резервов, больше ничего. Положив 100 токенов и
// 0.0000333 ETH, получаешь цену 0.000000333 ETH за токен, и она станет
// «рыночной» просто потому, что других источников цены нет.

const WEI = 10n ** 18n

/** Сколько ETH нужно в пуле, чтобы цена токена вышла targetPriceUsd. */
export function ethForTargetPrice({ poolTokens, targetPriceUsd, ethUsd }) {
  if (poolTokens <= 0) throw new Error('poolTokens должно быть больше нуля')
  if (targetPriceUsd <= 0) throw new Error('targetPriceUsd должно быть больше нуля')
  if (ethUsd <= 0) throw new Error('ethUsd должно быть больше нуля')

  return (poolTokens * targetPriceUsd) / ethUsd
}

/** Сколько токенов нужно в пуле при заданном количестве ETH. */
export function tokensForTargetPrice({ poolEth, targetPriceUsd, ethUsd }) {
  if (poolEth <= 0) throw new Error('poolEth должно быть больше нуля')
  return (poolEth * ethUsd) / targetPriceUsd
}

/**
 * Полная картина по пулу: цена, что покажет кошелёк, и насколько пул тонкий.
 * @param {number} poolTokens токенов в пул
 * @param {number} poolEth ETH в пул
 * @param {number} balanceTokens весь баланс держателя, включая уходящее в пул
 * @param {number} ethUsd курс ETH, только для перевода в доллары
 */
export function describePlan({ poolTokens, poolEth, balanceTokens, ethUsd }) {
  if (poolTokens > balanceTokens) {
    throw new Error(`в пул нужно ${poolTokens} токенов, а на балансе ${balanceTokens}`)
  }

  const priceEth = poolEth / poolTokens
  const priceUsd = priceEth * ethUsd
  const remainingTokens = balanceTokens - poolTokens

  return {
    priceEth,
    priceUsd,
    remainingTokens,
    // Кошелёк умножает цену на весь баланс, включая заперутое в пуле — но токены
    // в пуле принадлежат уже пулу, поэтому считаем по остатку.
    displayedUsd: remainingTokens * priceUsd,
    liquidityUsd: poolEth * ethUsd * 2, // обе стороны пула
    // Продажа x токенов в пул с резервом T роняет цену вдвое при x = T*(sqrt(2)-1).
    tokensToHalvePrice: poolTokens * (Math.SQRT2 - 1),
  }
}

/** Перевод в целочисленные единицы для транзакции. */
export function toWei(amount) {
  const [whole, fraction = ''] = amount.toFixed(18).split('.')
  return BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'))
}
