import test from 'node:test'
import assert from 'node:assert/strict'
import {
  add,
  sub,
  mul,
  scale,
  evaluate,
  divmod,
  interpolate,
  vanishing,
  degree,
  trim,
  mod,
  R,
  Fr,
} from '../scripts/zk/poly.mjs'

test('trim убирает ведущие нули, степень считается честно', () => {
  assert.deepEqual(trim([1n, 2n, 0n, 0n]), [1n, 2n])
  assert.equal(degree([1n, 2n, 0n]), 1)
  assert.equal(degree([]), -1)
})

test('сложение и вычитание идут по модулю поля', () => {
  assert.deepEqual(add([1n, 2n], [3n]), [4n, 2n])
  assert.deepEqual(sub([1n], [1n]), [], 'нулевой полином — пустой массив')
  assert.deepEqual(add([R - 1n], [2n]), [1n], 'перенос через модуль')
})

test('умножение: (1 + x)(1 - x) = 1 - x^2', () => {
  const result = mul([1n, 1n], [1n, mod(-1n)])
  assert.deepEqual(result, [1n, 0n, mod(-1n)])
})

test('вычисление по Горнеру совпадает с прямым подсчётом', () => {
  const poly = [5n, 3n, 2n] // 5 + 3x + 2x^2
  for (const x of [0n, 1n, 2n, 7n, R - 3n]) {
    const direct = mod(5n + 3n * x + 2n * x * x)
    assert.equal(evaluate(poly, x), direct, `x = ${x}`)
  }
})

test('деление без остатка: (x^2 - 1) / (x - 1) = x + 1', () => {
  const { quotient, remainder } = divmod([mod(-1n), 0n, 1n], [mod(-1n), 1n])

  assert.deepEqual(quotient, [1n, 1n])
  assert.deepEqual(remainder, [], 'остатка быть не должно')
})

test('деление с остатком согласовано: n = q*d + r', () => {
  const n = [7n, 3n, 0n, 5n]
  const d = [1n, 2n]
  const { quotient, remainder } = divmod(n, d)

  assert.deepEqual(add(mul(quotient, d), remainder), trim(n))
})

test('деление на нулевой полином отбивается', () => {
  assert.throws(() => divmod([1n], []), /нулевой полином/)
  assert.throws(() => divmod([1n], [0n, 0n]), /нулевой полином/)
})

test('интерполяция проходит ровно через заданные точки', () => {
  const xs = [1n, 2n, 3n, 4n]
  const ys = [5n, 0n, 9n, 2n]
  const poly = interpolate(xs, ys)

  assert.ok(degree(poly) < xs.length, 'степень должна быть меньше числа точек')
  for (let i = 0; i < xs.length; i++) {
    assert.equal(evaluate(poly, xs[i]), ys[i], `точка x = ${xs[i]}`)
  }
})

test('интерполяция нулей даёт нулевой полином', () => {
  assert.deepEqual(interpolate([1n, 2n, 3n], [0n, 0n, 0n]), [])
})

test('интерполяция отбивает несовпадающие длины', () => {
  assert.throws(() => interpolate([1n, 2n], [1n]), /разное число/)
})

test('Z(x) обнуляется ровно в своих точках', () => {
  const points = [1n, 2n, 3n, 4n]
  const z = vanishing(points)

  assert.equal(degree(z), points.length)
  for (const point of points) assert.equal(evaluate(z, point), 0n, `Z(${point}) должен быть 0`)
  assert.notEqual(evaluate(z, 5n), 0n, 'вне точек Z обязан быть ненулевым')
})

test('масштабирование на ноль обнуляет полином', () => {
  assert.deepEqual(scale([1n, 2n, 3n], 0n), [])
})

test('обратный элемент поля согласован с делением', () => {
  const value = 12345n
  assert.equal(mod(value * Fr.inv(value)), 1n)
})
