// Схема и её перевод в QAP.
//
// Доказываемое утверждение: «я знаю x, для которого x^3 + x + 5 = out»,
// где out публичен, а x — секрет. Это каноничный пример, на нём видна вся
// механика, и при этом он достаточно мал, чтобы всё проверить руками.
//
// R1CS — набор констрейнтов вида (A·w) * (B·w) = (C·w), где w — вектор всех
// значений в схеме. Схема раскладывается на умножения по одному на констрейнт:
//
//   sym_1 = x * x
//   y     = sym_1 * x        (то есть x^3)
//   sym_2 = y + x
//   out   = sym_2 + 5
//
// Провода (wires) в порядке: [1, out, x, sym_1, y, sym_2]
// Публичных — два: константа 1 и out. Остальные — часть свидетельства.
import { interpolate, vanishing, mod, evaluate, mul, sub, divmod } from './poly.mjs'

export const WIRES = ['one', 'out', 'x', 'sym_1', 'y', 'sym_2']
export const NUM_PUBLIC = 2 // 'one' и 'out'

const W = { one: 0, out: 1, x: 2, sym_1: 3, y: 4, sym_2: 5 }

/** Строка матрицы из пар «провод: коэффициент». */
function row(entries) {
  const out = new Array(WIRES.length).fill(0n)
  for (const [wire, value] of Object.entries(entries)) out[W[wire]] = mod(BigInt(value))
  return out
}

// Каждый констрейнт: A * B = C.
export const CONSTRAINTS = [
  // x * x = sym_1
  { a: row({ x: 1 }), b: row({ x: 1 }), c: row({ sym_1: 1 }) },
  // sym_1 * x = y
  { a: row({ sym_1: 1 }), b: row({ x: 1 }), c: row({ y: 1 }) },
  // (y + x) * 1 = sym_2
  { a: row({ y: 1, x: 1 }), b: row({ one: 1 }), c: row({ sym_2: 1 }) },
  // (sym_2 + 5) * 1 = out
  { a: row({ sym_2: 1, one: 5 }), b: row({ one: 1 }), c: row({ out: 1 }) },
]

/** Считает все провода схемы для данного секрета x. */
export function witness(x) {
  const value = mod(BigInt(x))
  const sym_1 = mod(value * value)
  const y = mod(sym_1 * value)
  const sym_2 = mod(y + value)
  const out = mod(sym_2 + 5n)

  const w = new Array(WIRES.length).fill(0n)
  w[W.one] = 1n
  w[W.out] = out
  w[W.x] = value
  w[W.sym_1] = sym_1
  w[W.y] = y
  w[W.sym_2] = sym_2
  return w
}

const dot = (row, w) => row.reduce((acc, coefficient, i) => mod(acc + coefficient * w[i]), 0n)

/** Проверка свидетельства напрямую по R1CS — до всякой криптографии. */
export function satisfiesR1CS(w) {
  return CONSTRAINTS.every(({ a, b, c }) => mod(dot(a, w) * dot(b, w)) === dot(c, w))
}

/**
 * R1CS -> QAP. Для каждого провода i строится по полиному из каждой матрицы:
 * A_i интерполирует значения i-го столбца матрицы A по точкам 1..n.
 *
 * Смысл: система из n констрейнтов превращается в одно полиномиальное тождество
 * A(x)B(x) - C(x) = H(x)Z(x), где Z обнуляется в точках констрейнтов.
 */
export function toQAP() {
  const points = CONSTRAINTS.map((_, index) => BigInt(index + 1))

  const column = (matrix, wire) => CONSTRAINTS.map((constraint) => constraint[matrix][wire])

  const A = WIRES.map((_, wire) => interpolate(points, column('a', wire)))
  const B = WIRES.map((_, wire) => interpolate(points, column('b', wire)))
  const C = WIRES.map((_, wire) => interpolate(points, column('c', wire)))

  return { A, B, C, Z: vanishing(points), points, numConstraints: CONSTRAINTS.length }
}

/** Свёртка полиномов провода со свидетельством: Σ w_i * P_i(x). */
export function combine(polys, w) {
  let acc = []
  for (let i = 0; i < polys.length; i++) {
    if (w[i] === 0n) continue
    const scaled = polys[i].map((coefficient) => mod(coefficient * w[i]))
    const length = Math.max(acc.length, scaled.length)
    const next = new Array(length).fill(0n)
    for (let j = 0; j < length; j++) next[j] = mod((acc[j] ?? 0n) + (scaled[j] ?? 0n))
    acc = next
  }
  while (acc.length && acc[acc.length - 1] === 0n) acc.pop()
  return acc
}

/**
 * H(x) = (A(x)B(x) - C(x)) / Z(x). Делится без остатка ровно тогда, когда
 * свидетельство удовлетворяет всем констрейнтам — в этом вся суть QAP.
 */
export function quotient(qap, w) {
  const a = combine(qap.A, w)
  const b = combine(qap.B, w)
  const c = combine(qap.C, w)

  const { quotient: h, remainder } = divmod(sub(mul(a, b), c), qap.Z)
  return { h, remainder, a, b, c }
}

export { evaluate }
