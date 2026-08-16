// Оптимальный размер арбитражной сделки между двумя пулами constant product.
//
// ЗАДАЧА. Два пула торгуют одной парой по разной цене. Покупаем в дешёвом,
// продаём в дорогом, всё в одной транзакции. Сколько именно занять?
// Мало — оставим прибыль на столе. Много — сами сдвинем цены и съедим её.
//
// ВЫВОД. Пул 1 с резервами (a1, b1), пул 2 с (a2, b2), gamma = 1 - комиссия.
// Вкладываем x токена A в первый пул:
//
//   out1 = gamma*x*b1 / (a1 + gamma*x)
//
// Полученное B продаём во втором:
//
//   out2 = gamma*out1*a2 / (b2 + gamma*out1)
//
// Подстановка u = gamma*x сворачивает это в дробно-линейную функцию:
//
//   out2 = C*u / (E + F*u),   C = gamma*a2*b1,  E = a1*b2,  F = b2 + gamma*b1
//
// Прибыль P(u) = out2 - u/gamma. Производная дробно-линейной функции:
//
//   d(out2)/du = C*E / (E + F*u)^2
//
// Приравниваем к 1/gamma (условие максимума) и получаем, что знаменатель —
// геометрическое среднее произведения резервов:
//
//   (E + F*u)^2 = gamma^2 * a1*a2*b1*b2
//   E + F*u = gamma * sqrt(a1*a2*b1*b2)
//
// Отсюда прямо:
//
//   u* = (gamma*sqrt(a1*a2*b1*b2) - a1*b2) / (b2 + gamma*b1)
//   x* = u* / gamma
//
// Никакого подбора и градиентного спуска — одна формула с корнем.
//
// УСЛОВИЕ ВЫГОДНОСТИ. u* > 0 равносильно gamma^2*a2*b1 > a1*b2, то есть
// цена в первом пуле должна отличаться от второго больше, чем на двойную
// комиссию. Двойную — потому что комиссию платим в обоих пулах.

/** Целочисленный квадратный корень: floor(sqrt(n)) методом Ньютона. */
export function isqrt(n) {
  if (n < 0n) throw new Error('корень из отрицательного')
  if (n < 2n) return n

  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

/** Стандартный getAmountOut Uniswap V2 на целых числах. */
export function amountOut(amountIn, reserveIn, reserveOut, feeBps = 30n) {
  if (amountIn <= 0n) return 0n
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n

  const withFee = amountIn * (10_000n - feeBps)
  return (withFee * reserveOut) / (reserveIn * 10_000n + withFee)
}

/**
 * Оптимальный вход по замкнутой формуле.
 *
 * @param {bigint} a1 резерв токена A в пуле, где покупаем
 * @param {bigint} b1 резерв токена B там же
 * @param {bigint} a2 резерв A в пуле, где продаём
 * @param {bigint} b2 резерв B там же
 * @returns {{amountIn: bigint, profit: bigint, viable: boolean, reason?: string}}
 */
export function optimalArb({ a1, b1, a2, b2, feeBps = 30n }) {
  if ([a1, b1, a2, b2].some((r) => r <= 0n)) {
    return { amountIn: 0n, profit: 0n, viable: false, reason: 'пустые резервы' }
  }

  const gammaNum = 10_000n - feeBps
  const gammaDen = 10_000n

  // Условие выгодности: gamma^2 * a2*b1 > a1*b2, в целых числах без деления.
  const left = gammaNum * gammaNum * a2 * b1
  const right = gammaDen * gammaDen * a1 * b2
  if (left <= right) {
    return { amountIn: 0n, profit: 0n, viable: false, reason: 'разница цен меньше двойной комиссии' }
  }

  // u* = (gamma*sqrt(a1*a2*b1*b2) - a1*b2) / (b2 + gamma*b1), затем x* = u*/gamma.
  // Всё домножено на gammaDen, чтобы делить один раз в конце.
  const root = isqrt(a1 * a2 * b1 * b2)
  const numerator = gammaNum * root - gammaDen * a1 * b2
  const denominator = gammaDen * b2 + gammaNum * b1

  if (numerator <= 0n) {
    return { amountIn: 0n, profit: 0n, viable: false, reason: 'оптимум в нуле' }
  }

  const amountIn = numerator / denominator

  if (amountIn <= 0n) {
    return { amountIn: 0n, profit: 0n, viable: false, reason: 'оптимум меньше единицы' }
  }

  return { amountIn, profit: profitOf(amountIn, { a1, b1, a2, b2, feeBps }), viable: true }
}

/** Прибыль от сделки размером amountIn: сколько A вернётся сверх вложенного. */
export function profitOf(amountIn, { a1, b1, a2, b2, feeBps = 30n }) {
  const gotB = amountOut(amountIn, a1, b1, feeBps)
  const gotA = amountOut(gotB, b2, a2, feeBps)
  return gotA - amountIn
}

/**
 * Прибыль после вычета газа. Единственное число, которое имеет значение:
 * положительная прибыль до газа встречается на порядок чаще, чем после.
 */
export function netProfit({ amountIn, pools, gasUnits, gasPriceWei, flashFeeBps = 0n }) {
  const gross = profitOf(amountIn, pools)
  const flashFee = (amountIn * flashFeeBps) / 10_000n
  const gas = gasUnits * gasPriceWei
  return gross - flashFee - gas
}
