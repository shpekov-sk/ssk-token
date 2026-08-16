// Проверка того же доказательства двумя независимыми путями: JS-верификатором
// на @noble/curves и контрактом на прекомпайлах EVM. Если они расходятся —
// ошибка либо в кодировании точек (EIP-197 требует мнимую часть Fp2 первой),
// либо в самой схеме.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createChain, deploy } from './harness.mjs'
import { setup, prove, verify } from '../scripts/zk/groth16.mjs'
import { verifyingKeyToCalldata, proofToCalldata, g1ToCalldata } from '../scripts/zk/calldata.mjs'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

const keys = setup()

async function deployVerifier() {
  const chain = await createChain([KEY])
  const verifier = await deploy(chain, 'Groth16Verifier', verifyingKeyToCalldata(keys.verifyingKey))
  return { chain, account: chain.accounts[0], verifier }
}

test('контракт подтверждает доказательство, которое принял JS', async () => {
  const { verifier } = await deployVerifier()
  const proof = prove(keys, 3)

  assert.ok(verify(keys.verifyingKey, proof), 'JS-проверка')
  assert.equal(await verifier.read('verify', proofToCalldata(proof)), true, 'проверка в EVM')
})

test('оба верификатора согласны на разных секретах', async () => {
  const { verifier } = await deployVerifier()

  for (const secret of [1, 3, 7, 42, 1000]) {
    const proof = prove(keys, secret)

    assert.equal(verify(keys.verifyingKey, proof), true, `JS, x=${secret}`)
    assert.equal(await verifier.read('verify', proofToCalldata(proof)), true, `EVM, x=${secret}`)
  }
})

test('контракт отвергает подделанный публичный вход', async () => {
  const { verifier } = await deployVerifier()
  const [a, b, c] = proofToCalldata(prove(keys, 3))

  // Утверждаем out = 36 вместо настоящих 35.
  assert.equal(await verifier.read('verify', [a, b, c, [1n, 36n]]), false)
})

test('контракт отвергает испорченные точки доказательства', async () => {
  const { verifier } = await deployVerifier()
  const proof = prove(keys, 3)
  const [a, b, c, publicInputs] = proofToCalldata(proof)

  // Точки остаются на кривой — меняется только их значение.
  assert.equal(
    await verifier.read('verify', [g1ToCalldata(proof.A.double()), b, c, publicInputs]),
    false,
    'подменённый A',
  )
  assert.equal(
    await verifier.read('verify', [a, b, g1ToCalldata(proof.C.double()), publicInputs]),
    false,
    'подменённый C',
  )
})

test('публичный вход вне скалярного поля — отказ, а не тихое false', async () => {
  const { verifier, account } = await deployVerifier()
  const [a, b, c] = proofToCalldata(prove(keys, 3))

  const result = await verifier.trySend(account, 'verify', [a, b, c, [1n, R]])

  assert.ok(result.error, 'транзакция должна была упасть')
  assert.equal(result.revert.name, 'InvalidPublicInput')
  assert.equal(result.revert.args[0], R)
})

test('точка не на кривой роняет прекомпайл явной ошибкой', async () => {
  const { verifier, account } = await deployVerifier()
  const [, b, c, publicInputs] = proofToCalldata(prove(keys, 3))

  // (1, 1) не удовлетворяет y^2 = x^3 + 3.
  const result = await verifier.trySend(account, 'verify', [[1n, 1n], b, c, publicInputs])

  assert.ok(result.error)
  assert.equal(result.revert.name, 'PrecompileFailed')
})

test('вычислительная стоимость проверки постоянна', async () => {
  const { verifier, account } = await deployVerifier()

  const gasFor = async (secret) =>
    (await verifier.write(account, 'verify', proofToCalldata(prove(keys, secret)))).gasUsed

  const gas = [await gasFor(3), await gasFor(7), await gasFor(999999)]
  const spread = Number(gas.reduce((max, g) => (g > max ? g : max)) - gas.reduce((min, g) => (g < min ? g : min)))

  // Расхождение возможно только из-за нулевых байт в calldata (4 газа против 16
  // за байт), сама проверка — фиксированные четыре спаривания.
  assert.ok(spread < 500, `разброс ${spread} газа слишком велик для одинаковой работы`)
  console.log(`      проверка: ~${gas[0]} gas, разброс по calldata ${spread}`)
})

test('размер доказательства фиксирован: 8 чисел независимо от схемы', async () => {
  const [a, b, c, publicInputs] = proofToCalldata(prove(keys, 3))

  assert.equal(a.length, 2, 'A в G1')
  assert.equal(b.length, 4, 'B в G2')
  assert.equal(c.length, 2, 'C в G1')
  assert.equal(publicInputs.length, 2)
  assert.equal(a.length + b.length + c.length, 8, '256 байт доказательства')
})
