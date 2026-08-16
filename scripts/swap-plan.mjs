// Расчёт свопа, который приводит цену пула к целевой.
//
// В Uniswap V2 цена — это E/T (резерв квоты на резерв токена). Покупка толкает
// её вверх: ETH в пул добавляется целиком, а токенов выдаётся по формуле с
// комиссией. Отсюда точное количество ETH под нужную цену считается
// квадратным уравнением, а не подбором.

const FEE_BPS = 30n // 0.3% в Uniswap V2

/** Стандартный getAmountOut из UniswapV2Library. */
export function getAmountOut({ amountIn, reserveIn, reserveOut, feeBps = FEE_BPS }) {
  if (amountIn <= 0n) throw new Error('amountIn должен быть больше нуля')
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('в пуле нет резервов')

  const amountInWithFee = amountIn * (10_000n - feeBps)
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 10_000n + amountInWithFee
  return numerator / denominator
}

/**
 * Сколько ETH влить, чтобы спот-цена стала targetPrice (в ETH за токен).
 *
 * Решается (E + x)(E + a*x) = target * T * E, где a = 1 - комиссия:
 * левая часть — это E' * T' * (T/... ) после раскрытия, правая — целевая цена.
 * Считается во float: результат всё равно округляется до wei, а от проскальзывания
 * защищает amountOutMin.
 */
export function ethInForTargetPrice({ wethReserve, tokenReserve, targetPrice, feeBps = 30 }) {
  if (wethReserve <= 0 || tokenReserve <= 0) throw new Error('в пуле нет резервов')
  if (targetPrice <= 0) throw new Error('targetPrice должен быть больше нуля')

  const current = wethReserve / tokenReserve
  if (targetPrice <= current) {
    throw new Error(
      `цена уже ${current.toExponential(4)} ETH, покупкой её можно только поднять — ` +
        `цель ${targetPrice.toExponential(4)} ниже или равна текущей`,
    )
  }

  const a = 1 - feeBps / 10_000
  const E = wethReserve
  const C = targetPrice * tokenReserve * E

  // a*x^2 + E*(1+a)*x + (E^2 - C) = 0
  const b = E * (1 + a)
  const c = E * E - C
  const discriminant = b * b - 4 * a * c

  if (discriminant < 0) throw new Error('нет решения — проверь резервы и цель')

  return (-b + Math.sqrt(discriminant)) / (2 * a)
}

/** Что станет с пулом после покупки на ethIn — для проверки плана. */
export function priceAfterSwap({ wethReserve, tokenReserve, ethIn, feeBps = 30 }) {
  const a = 1 - feeBps / 10_000
  const effective = ethIn * a
  const tokensOut = (effective * tokenReserve) / (wethReserve + effective)

  const newWeth = wethReserve + ethIn
  const newToken = tokenReserve - tokensOut

  return { tokensOut, wethReserve: newWeth, tokenReserve: newToken, price: newWeth / newToken }
}
