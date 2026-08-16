import test from 'node:test'
import assert from 'node:assert/strict'
import { witness, satisfiesR1CS, toQAP, quotient, combine, CONSTRAINTS, WIRES, NUM_PUBLIC } from '../scripts/zk/circuit.mjs'
import { evaluate, mod, degree, R } from '../scripts/zk/poly.mjs'

test('свидетельство считает схему верно: x=3 даёт out=35', () => {
  const w = witness(3)

  assert.equal(w[0], 1n, 'нулевой провод — константа 1')
  assert.equal(w[1], 35n, 'out = 27 + 3 + 5')
  assert.equal(w[2], 3n, 'x')
  assert.equal(w[3], 9n, 'x^2')
  assert.equal(w[4], 27n, 'x^3')
})

test('верное свидетельство удовлетворяет R1CS, подделанное — нет', () => {
  assert.ok(satisfiesR1CS(witness(3)))
  assert.ok(satisfiesR1CS(witness(7)))

  const broken = witness(3)
  broken[1] = 36n // соврали про out
  assert.equal(satisfiesR1CS(broken), false)
})

test('каждый констрейнт действительно про одно умножение', () => {
  assert.equal(CONSTRAINTS.length, 4)
  for (const { a, b, c } of CONSTRAINTS) {
    assert.equal(a.length, WIRES.length)
    assert.equal(b.length, WIRES.length)
    assert.equal(c.length, WIRES.length)
  }
})

test('QAP: полиномы провода воспроизводят столбцы матриц в точках констрейнтов', () => {
  const qap = toQAP()

  for (let constraint = 0; constraint < CONSTRAINTS.length; constraint++) {
    const point = qap.points[constraint]
    for (let wire = 0; wire < WIRES.length; wire++) {
      assert.equal(evaluate(qap.A[wire], point), CONSTRAINTS[constraint].a[wire], `A[${wire}] в точке ${point}`)
      assert.equal(evaluate(qap.B[wire], point), CONSTRAINTS[constraint].b[wire], `B[${wire}] в точке ${point}`)
      assert.equal(evaluate(qap.C[wire], point), CONSTRAINTS[constraint].c[wire], `C[${wire}] в точке ${point}`)
    }
  }
})

test('главное свойство QAP: делится без остатка только на верном свидетельстве', () => {
  const qap = toQAP()

  const good = quotient(qap, witness(3))
  assert.deepEqual(good.remainder, [], 'верное свидетельство должно делиться нацело')

  const broken = witness(3)
  broken[4] = 26n // соврали про x^3
  const bad = quotient(qap, broken)
  assert.notDeepEqual(bad.remainder, [], 'подделка обязана оставить остаток')
})

test('тождество A*B - C = H*Z выполняется в случайной точке', () => {
  const qap = toQAP()
  const w = witness(5)
  const { h, a, b, c } = quotient(qap, w)

  // Проверяем в точке, которой нет среди констрейнтов: там Z != 0.
  const tau = 123456789n
  const left = mod(evaluate(a, tau) * evaluate(b, tau) - evaluate(c, tau))
  const right = mod(evaluate(h, tau) * evaluate(qap.Z, tau))

  assert.equal(left, right)
})

test('степень H равна n-2 — от неё зависит размер CRS', () => {
  const qap = toQAP()
  const { h } = quotient(qap, witness(3))

  assert.equal(degree(h), qap.numConstraints - 2, 'иначе не хватит степеней tau в setup')
})

test('свёртка со свидетельством линейна', () => {
  const qap = toQAP()
  const w = witness(4)
  const combined = combine(qap.A, w)

  // Значение свёртки в точке = скалярное произведение строки матрицы на w.
  const point = qap.points[0]
  const expected = CONSTRAINTS[0].a.reduce((acc, coefficient, i) => mod(acc + coefficient * w[i]), 0n)

  assert.equal(evaluate(combined, point), expected)
})

test('публичных проводов ровно два: единица и результат', () => {
  assert.equal(NUM_PUBLIC, 2)
  assert.deepEqual(WIRES.slice(0, NUM_PUBLIC), ['one', 'out'])
})

test('схема работает и на больших x, по модулю поля', () => {
  const big = R - 2n
  const w = witness(big)

  assert.ok(satisfiesR1CS(w))
  assert.deepEqual(quotient(toQAP(), w).remainder, [])
})
