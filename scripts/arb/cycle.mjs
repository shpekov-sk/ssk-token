// Арбитраж по циклу: A -> B -> C -> A внутри одной биржи.
//
// СВЁРТКА ЦЕПОЧКИ. Два свопа подряд складываются в один эквивалентный пул.
// Для хопа с резервами (a, b) и gamma = 1 - комиссия:
//
//   out = gamma*x*b / (a + gamma*x)
//
// Подставляя второй хоп в первый и приводя к тому же виду, получаем:
//
//   A_eff = a1*a2 / (a2 + gamma*b1)
//   B_eff = gamma*b1*b2 / (a2 + gamma*b1)
//
// То есть композиция свопов замкнута: цепочка любой длины сворачивается в одну
// пару (A, B). Это и делает цикл считаемым — иначе пришлось бы оптимизировать
// функцию от нескольких переменных.
//
// ОПТИМУМ ЦИКЛА. Прибыль P(x) = gamma*x*B/(A + gamma*x) - x. Производная,
// приравненная к единице, даёт:
//
//   (A + gamma*x)^2 = gamma*A*B    =>    x* = (sqrt(gamma*A*B) - A) / gamma
//
// Цикл выгоден тогда и только тогда, когда gamma*B > A. Содержательно: после
// всех комиссий за круг должно вернуться больше, чем вложено.
import { isqrt } from './optimal.mjs'

const SCALE = 10n ** 18n

/**
 * Складывает цепочку хопов в один эффективный пул.
 * @param {Array<{reserveIn: bigint, reserveOut: bigint, feeBps: bigint}>} hops
 */
export function foldChain(hops) {
  if (!hops.length) throw new Error('пустая цепочка')

  let { reserveIn: A, reserveOut: B } = hops[0]
  const gamma = (fee) => 10_000n - fee

  // Комиссию первого хопа вносим в общий gamma ниже, поэтому здесь только геометрия.
  let feeBps = hops[0].feeBps

  for (let i = 1; i < hops.length; i++) {
    const hop = hops[i]
    if (hop.reserveIn <= 0n || hop.reserveOut <= 0n) return null

    const g = gamma(feeBps)
    // A_eff = A*a2 / (a2 + g*B/10000);  B_eff = g*B*b2 / (10000*a2 + g*B)
    const denominator = 10_000n * hop.reserveIn + g * B
    if (denominator === 0n) return null

    const nextA = (A * hop.reserveIn * 10_000n) / denominator
    const nextB = (g * B * hop.reserveOut) / denominator

    A = nextA
    B = nextB
    feeBps = hop.feeBps // комиссия последнего хопа остаётся внешней
  }

  return { A, B, feeBps }
}

/**
 * Оптимальный вход для цикла и прибыль от него.
 * @returns {{amountIn: bigint, profit: bigint, viable: boolean, reason?: string}}
 */
export function optimalCycle(hops) {
  const folded = foldChain(hops)
  if (!folded) return { amountIn: 0n, profit: 0n, viable: false, reason: 'пустой пул в цепочке' }

  const { A, B, feeBps } = folded
  if (A <= 0n || B <= 0n) return { amountIn: 0n, profit: 0n, viable: false, reason: 'вырожденная свёртка' }

  const g = 10_000n - feeBps

  // Условие выгодности gamma*B > A в целых числах.
  if (g * B <= 10_000n * A) {
    return { amountIn: 0n, profit: 0n, viable: false, reason: 'за круг возвращается меньше вложенного' }
  }

  // x* = (sqrt(gamma*A*B) - A) / gamma, всё в масштабе 10000.
  const root = isqrt(g * A * B * 10_000n)
  const numerator = root - 10_000n * A
  if (numerator <= 0n) return { amountIn: 0n, profit: 0n, viable: false, reason: 'оптимум в нуле' }

  const amountIn = numerator / g
  if (amountIn <= 0n) return { amountIn: 0n, profit: 0n, viable: false, reason: 'оптимум меньше единицы' }

  return { amountIn, profit: cycleProfit(amountIn, hops), viable: true }
}

/** Прогон суммы по цепочке хоп за хопом — эталон для проверки свёртки. */
export function runChain(amountIn, hops) {
  let amount = amountIn
  for (const hop of hops) {
    if (amount <= 0n) return 0n
    const withFee = amount * (10_000n - hop.feeBps)
    amount = (withFee * hop.reserveOut) / (hop.reserveIn * 10_000n + withFee)
  }
  return amount
}

export function cycleProfit(amountIn, hops) {
  return runChain(amountIn, hops) - amountIn
}

export { SCALE }
