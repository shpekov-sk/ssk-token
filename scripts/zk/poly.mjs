// Полиномы над скалярным полем BN254 (Fr). Коэффициенты — bigint по возрастанию
// степени: [3, 0, 2] это 3 + 2x^2.
//
// Всё, что нужно для превращения R1CS в QAP: интерполяция Лагранжа, умножение,
// деление с остатком.
import { bn254 } from '@noble/curves/bn254.js'

export const Fr = bn254.fields.Fr
export const R = Fr.ORDER

export const mod = (value) => ((value % R) + R) % R

/** Убирает ведущие нули, чтобы степень считалась честно. */
export function trim(poly) {
  let end = poly.length
  while (end > 0 && poly[end - 1] === 0n) end--
  return poly.slice(0, end)
}

export const degree = (poly) => trim(poly).length - 1

export function add(a, b) {
  const out = new Array(Math.max(a.length, b.length)).fill(0n)
  for (let i = 0; i < out.length; i++) out[i] = mod((a[i] ?? 0n) + (b[i] ?? 0n))
  return trim(out)
}

export function sub(a, b) {
  const out = new Array(Math.max(a.length, b.length)).fill(0n)
  for (let i = 0; i < out.length; i++) out[i] = mod((a[i] ?? 0n) - (b[i] ?? 0n))
  return trim(out)
}

export function scale(poly, factor) {
  return trim(poly.map((c) => mod(c * factor)))
}

export function mul(a, b) {
  if (a.length === 0 || b.length === 0) return []
  const out = new Array(a.length + b.length - 1).fill(0n)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0n) continue
    for (let j = 0; j < b.length; j++) {
      out[i + j] = mod(out[i + j] + a[i] * b[j])
    }
  }
  return trim(out)
}

export function evaluate(poly, at) {
  // Схема Горнера: n умножений вместо возведения в степень на каждом члене.
  let acc = 0n
  for (let i = poly.length - 1; i >= 0; i--) acc = mod(acc * at + poly[i])
  return acc
}

/** Деление с остатком: возвращает {quotient, remainder}. */
export function divmod(numerator, denominator) {
  const d = trim(denominator)
  if (d.length === 0) throw new Error('деление на нулевой полином')

  const n = trim(numerator).slice()
  const quotient = new Array(Math.max(0, n.length - d.length + 1)).fill(0n)
  const leadInverse = Fr.inv(d[d.length - 1])

  for (let i = n.length - d.length; i >= 0; i--) {
    const factor = mod(n[i + d.length - 1] * leadInverse)
    quotient[i] = factor
    if (factor === 0n) continue
    for (let j = 0; j < d.length; j++) {
      n[i + j] = mod(n[i + j] - factor * d[j])
    }
  }

  return { quotient: trim(quotient), remainder: trim(n) }
}

/**
 * Интерполяция Лагранжа: единственный полином степени < n через n точек.
 * Считается прямо по формуле — для наших размеров (единицы констрейнтов) этого
 * достаточно, а FFT потребовал бы корней из единицы нужного порядка.
 */
export function interpolate(xs, ys) {
  if (xs.length !== ys.length) throw new Error('разное число x и y')

  let result = []
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] === 0n) continue

    // Базисный полином: произведение (x - xs[j]) / (xs[i] - xs[j]) по всем j != i.
    let basis = [1n]
    let denominator = 1n
    for (let j = 0; j < xs.length; j++) {
      if (i === j) continue
      basis = mul(basis, [mod(-xs[j]), 1n])
      denominator = mod(denominator * mod(xs[i] - xs[j]))
    }

    result = add(result, scale(basis, mod(ys[i] * Fr.inv(denominator))))
  }
  return result
}

/** Целевой полином QAP: Z(x) = (x - 1)(x - 2)...(x - n). */
export function vanishing(points) {
  let z = [1n]
  for (const point of points) z = mul(z, [mod(-point), 1n])
  return z
}
