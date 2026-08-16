import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, prove, verify, randomScalar, pointHex, G1, G2 } from '../scripts/zk/groth16.mjs'
import { witness, satisfiesR1CS } from '../scripts/zk/circuit.mjs'
import { mod } from '../scripts/zk/poly.mjs'

// Одна настройка на весь файл: она детерминирована относительно secret,
// а генерация ключей — самая дорогая часть.
const keys = setup()

test('доказательство знания x=3 проверяется, out=35 публичен', () => {
  const proof = prove(keys, 3)

  assert.deepEqual(proof.publicInputs, [1n, 35n])
  assert.ok(verify(keys.verifyingKey, proof))
})

test('работает на других секретах: x=7 даёт out=355', () => {
  const proof = prove(keys, 7)

  assert.deepEqual(proof.publicInputs, [1n, 355n])
  assert.ok(verify(keys.verifyingKey, proof))
})

test('доказательство не выдаёт секрет: три точки, x среди них нет', () => {
  const proof = prove(keys, 3)

  assert.deepEqual(Object.keys(proof).sort(), ['A', 'B', 'C', 'publicInputs'])
  // Единственное, что уходит проверяющему открытым текстом — публичные входы.
  assert.equal(proof.publicInputs.includes(3n), false, 'x не должен появляться в доказательстве')
})

test('ослепление работает: два доказательства одного факта различаются', () => {
  const first = prove(keys, 3)
  const second = prove(keys, 3)

  assert.notEqual(pointHex(first.A), pointHex(second.A), 'точки обязаны отличаться')
  assert.notEqual(pointHex(first.C), pointHex(second.C))
  assert.ok(verify(keys.verifyingKey, first))
  assert.ok(verify(keys.verifyingKey, second))
})

test('подмена публичного входа ломает проверку', () => {
  const proof = prove(keys, 3)
  const lying = { ...proof, publicInputs: [1n, 36n] }

  assert.equal(verify(keys.verifyingKey, lying), false, 'нельзя выдать 35 за 36')
})

test('порча любой из трёх точек ломает проверку', () => {
  const proof = prove(keys, 3)

  assert.equal(verify(keys.verifyingKey, { ...proof, A: proof.A.add(G1.BASE) }), false, 'A')
  assert.equal(verify(keys.verifyingKey, { ...proof, B: proof.B.add(G2.BASE) }), false, 'B')
  assert.equal(verify(keys.verifyingKey, { ...proof, C: proof.C.add(G1.BASE) }), false, 'C')
})

test('доказательство от другой настройки не проходит', () => {
  const other = setup()
  const proof = prove(other, 3)

  assert.ok(verify(other.verifyingKey, proof), 'в своей настройке — валидно')
  assert.equal(verify(keys.verifyingKey, proof), false, 'в чужой — нет')
})

test('нельзя доказать то, чего не знаешь: свидетельство проверяется до крипты', () => {
  const broken = witness(3)
  broken[4] = 26n

  assert.equal(satisfiesR1CS(broken), false)
  // prove считает свидетельство сам, поэтому подсунуть кривое можно только через
  // прямое обращение к QAP — и там остаток от деления сразу это ловит.
  assert.throws(() => prove({ ...keys, qap: keys.qap }, undefined), /не удовлетворяет|Cannot|NaN/)
})

test('ослепляющие множители можно задать — доказательство становится детерминированным', () => {
  const blinding = { r: 111n, s: 222n }
  const first = prove(keys, 3, blinding)
  const second = prove(keys, 3, blinding)

  assert.equal(pointHex(first.A), pointHex(second.A))
  assert.ok(verify(keys.verifyingKey, first))
})

test('нулевое ослепление тоже даёт валидное доказательство', () => {
  const proof = prove(keys, 3, { r: 0n, s: 0n })
  assert.ok(verify(keys.verifyingKey, proof))
})

test('размер доказательства не зависит от секрета', () => {
  const small = prove(keys, 1)
  const big = prove(keys, mod(-1n))

  assert.equal(pointHex(small.A).length, pointHex(big.A).length)
  assert.ok(verify(keys.verifyingKey, small))
  assert.ok(verify(keys.verifyingKey, big))
})

test('вырожденный tau в настройке отбивается', () => {
  const secret = { alpha: 2n, beta: 3n, gamma: 5n, delta: 7n, tau: 1n }
  assert.throws(() => setup(secret), /вырожденный tau/)
})

test('настройка на заданном секрете воспроизводима', () => {
  const secret = { alpha: 11n, beta: 13n, gamma: 17n, delta: 19n, tau: 23n }
  const a = setup(secret)
  const b = setup(secret)

  assert.equal(pointHex(a.verifyingKey.alphaG1), pointHex(b.verifyingKey.alphaG1))
  assert.ok(verify(a.verifyingKey, prove(b, 3)), 'ключи взаимозаменяемы при одном секрете')
})

test('randomScalar не выдаёт ноль и лежит в поле', () => {
  for (let i = 0; i < 50; i++) {
    const value = randomScalar()
    assert.notEqual(value, 0n)
    assert.equal(value, mod(value))
  }
})
