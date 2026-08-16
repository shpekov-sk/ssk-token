// Влияние сделки на цену пула constant product.
//
// Нужно, чтобы «микро-своп ради индексатора» не оказался покупкой, сдвигающей
// цену на десятки процентов: в пуле глубиной $0.60 это очень легко.
/** Стандартный getAmountOut из UniswapV2Library, на целых числах. */
function amountOut(amountIn, reserveIn, reserveOut, feeBps = 30n) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n

  const withFee = amountIn * (10_000n - feeBps)
  return (withFee * reserveOut) / (reserveIn * 10_000n + withFee)
}

/**
 * @param {bigint} reserveIn резерв токена, который вкладывают
 * @param {bigint} reserveOut резерв токена, который получают
 * @param {bigint} amountIn размер сделки
 * @returns влияние на цену в bps и цена до/после в единицах out на единицу in
 */
export function impactOf({ reserveIn, reserveOut, amountIn, feeBps = 30n }) {
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('в пуле нет резервов')
  if (amountIn <= 0n) throw new Error('размер сделки должен быть больше нуля')

  const received = amountOut(amountIn, reserveIn, reserveOut, feeBps)
  const newIn = reserveIn + amountIn
  const newOut = reserveOut - received

  // Цену считаем как out/in: она падает по мере выкупа out.
  const before = Number(reserveOut) / Number(reserveIn)
  const after = Number(newOut) / Number(newIn)

  // Знак: для покупателя цена out растёт, поэтому берём обратную величину.
  const priceBefore = 1 / before
  const priceAfter = 1 / after

  return {
    received,
    priceBefore,
    priceAfter,
    impactBps: Math.round(((priceAfter - priceBefore) / priceBefore) * 10_000),
    reserveInAfter: newIn,
    reserveOutAfter: newOut,
  }
}

/**
 * Наибольшая сделка, которая не сдвинет цену больше чем на maxImpactBps.
 * Ищется двоичным поиском: аналитическая формула тут не короче и не понятнее.
 */
export function largestTradeWithin({ reserveIn, reserveOut, maxImpactBps, feeBps = 30n }) {
  let low = 0n
  let high = reserveIn // больше резерва вкладывать бессмысленно

  for (let step = 0; step < 80 && high - low > 1n; step++) {
    const mid = low + (high - low) / 2n
    if (mid === 0n) break
    const { impactBps } = impactOf({ reserveIn, reserveOut, amountIn: mid, feeBps })
    if (impactBps <= maxImpactBps) low = mid
    else high = mid
  }

  return low
}
