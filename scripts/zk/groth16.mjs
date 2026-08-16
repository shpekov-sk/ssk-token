// Groth16 на BN254: доверенная настройка, доказательство, проверка.
//
// Что доказывается: «я знаю x, для которого x^3 + x + 5 = out», при публичном
// out и скрытом x. Доказательство — три точки кривой, проверка — четыре
// спаривания, и ни то, ни другое не растёт с размером схемы.
//
// Про настройку честно: toxic waste (alpha, beta, gamma, delta, tau) здесь
// генерируется локально и возвращается вызывающему для тестов. Кто знает эти
// числа, может подделать доказательство на любое утверждение. В реальности
// настройку проводят многосторонней церемонией, где секрет целиком не собирается
// ни у кого.
import { bn254 } from '@noble/curves/bn254.js'
import { randomBytes } from 'node:crypto'
import { NUM_PUBLIC, toQAP, quotient, witness } from './circuit.mjs'
import { Fr, mod, evaluate } from './poly.mjs'

const G1 = bn254.G1.ProjectivePoint
const G2 = bn254.G2.ProjectivePoint
const Fp12 = bn254.fields.Fp12

/** Случайный ненулевой скаляр поля. */
export function randomScalar() {
  while (true) {
    const value = mod(BigInt(`0x${randomBytes(32).toString('hex')}`))
    if (value !== 0n) return value
  }
}

const g1 = (scalar) => mulSafe(G1.BASE, scalar, G1.ZERO)
const g2 = (scalar) => mulSafe(G2.BASE, scalar, G2.ZERO)

/**
 * Умножение точки на скаляр, терпимое к нулю: noble отвергает scalar = 0,
 * а в Groth16 нулевые множители — законный случай (например r = 0).
 */
export function mulSafe(point, scalar, zero) {
  const value = mod(scalar)
  return value === 0n ? zero : point.multiply(value)
}

/**
 * Сериализация точки. Штатный toHex в bn254 не реализован, а сравнивать точки
 * в тестах и печатать их в ключах всё равно нужно.
 */
export function pointHex(point) {
  const hex = (value) => value.toString(16).padStart(64, '0')
  if (point.is0()) return '0x' + '0'.repeat(64)

  const affine = point.toAffine()
  if (typeof affine.x === 'bigint') return `0x${hex(affine.x)}${hex(affine.y)}`
  // G2: координаты лежат в Fp2, у каждой две части.
  return `0x${hex(affine.x.c1)}${hex(affine.x.c0)}${hex(affine.y.c1)}${hex(affine.y.c0)}`
}

/** Степени tau по модулю поля: [1, tau, tau^2, ...]. */
function powers(tau, count) {
  const out = []
  let acc = 1n
  for (let i = 0; i < count; i++) {
    out.push(acc)
    acc = mod(acc * tau)
  }
  return out
}

/**
 * Доверенная настройка. Возвращает ключи и — только для тестов — сам секрет.
 * @param {object} [secret] заранее заданный toxic waste, иначе генерируется
 */
export function setup(secret) {
  const qap = toQAP()
  const numWires = qap.A.length

  const { alpha, beta, gamma, delta, tau } = secret ?? {
    alpha: randomScalar(),
    beta: randomScalar(),
    gamma: randomScalar(),
    delta: randomScalar(),
    tau: randomScalar(),
  }

  // tau не должен попасть в точку констрейнта: тогда Z(tau) = 0 и настройка вырождается.
  if (qap.points.some((point) => point === tau)) throw new Error('вырожденный tau — перегенерируй настройку')

  const gammaInverse = Fr.inv(gamma)
  const deltaInverse = Fr.inv(delta)

  // Полиномы провода, посчитанные в секретной точке tau.
  const At = qap.A.map((poly) => evaluate(poly, tau))
  const Bt = qap.B.map((poly) => evaluate(poly, tau))
  const Ct = qap.C.map((poly) => evaluate(poly, tau))
  const Zt = evaluate(qap.Z, tau)

  // Комбинация, связывающая A, B и C одного провода в одну точку.
  const combined = (wire) => mod(beta * At[wire] + alpha * Bt[wire] + Ct[wire])

  // H имеет степень n-2, значит нужно n-1 степеней tau.
  const tauPowers = powers(tau, qap.numConstraints - 1)

  const provingKey = {
    alphaG1: g1(alpha),
    betaG1: g1(beta),
    betaG2: g2(beta),
    deltaG1: g1(delta),
    deltaG2: g2(delta),
    // По точке на провод: для A в G1, для B — и в G1, и в G2.
    aG1: At.map(g1),
    bG1: Bt.map(g1),
    bG2: Bt.map(g2),
    // Приватная часть, поделённая на delta. Публичные провода тут нулевые:
    // за них отвечает icG1 в ключе проверки.
    privateG1: Array.from({ length: numWires }, (_, wire) =>
      wire < NUM_PUBLIC ? G1.ZERO : g1(mod(combined(wire) * deltaInverse)),
    ),
    // Степени tau, умноженные на Z(tau)/delta — по ним прувер коммитит H.
    hG1: tauPowers.map((power) => g1(mod(power * Zt * deltaInverse))),
  }

  const verifyingKey = {
    alphaG1: g1(alpha),
    betaG2: g2(beta),
    gammaG2: g2(gamma),
    deltaG2: g2(delta),
    // Публичная часть, поделённая на gamma.
    icG1: Array.from({ length: NUM_PUBLIC }, (_, wire) => g1(mod(combined(wire) * gammaInverse))),
  }

  return { qap, provingKey, verifyingKey, secret: { alpha, beta, gamma, delta, tau } }
}

/** Линейная комбинация точек: Σ scalars[i] * points[i]. */
function msm(points, scalars, zero) {
  let acc = zero
  for (let i = 0; i < scalars.length; i++) {
    const scalar = mod(scalars[i] ?? 0n)
    if (scalar === 0n) continue
    acc = acc.add(points[i].multiply(scalar))  // scalar уже проверен на ноль выше
  }
  return acc
}

/**
 * Доказательство. r и s — ослепляющие множители: из-за них одно и то же
 * утверждение каждый раз даёт разные точки, и связать два доказательства
 * между собой нельзя.
 */
export function prove({ qap, provingKey }, secretInput, blinding) {
  const w = witness(secretInput)
  const { h, remainder } = quotient(qap, w)
  if (remainder.length) throw new Error('свидетельство не удовлетворяет схеме')

  const r = blinding?.r ?? randomScalar()
  const s = blinding?.s ?? randomScalar()

  // A = alpha + Σ w_i A_i(tau) + r*delta
  const A = provingKey.alphaG1.add(msm(provingKey.aG1, w, G1.ZERO)).add(mulSafe(provingKey.deltaG1, r, G1.ZERO))

  // B нужен в G2 для проверки и в G1, чтобы собрать C.
  const B2 = provingKey.betaG2.add(msm(provingKey.bG2, w, G2.ZERO)).add(mulSafe(provingKey.deltaG2, s, G2.ZERO))
  const B1 = provingKey.betaG1.add(msm(provingKey.bG1, w, G1.ZERO)).add(mulSafe(provingKey.deltaG1, s, G1.ZERO))

  // C: приватная часть схемы, коммит H и компенсация ослепления.
  const privateScalars = w.map((value, wire) => (wire < NUM_PUBLIC ? 0n : value))
  const C = msm(provingKey.privateG1, privateScalars, G1.ZERO)
    .add(msm(provingKey.hG1, h, G1.ZERO))
    .add(mulSafe(A, s, G1.ZERO))
    .add(mulSafe(B1, r, G1.ZERO))
    .subtract(mulSafe(provingKey.deltaG1, mod(r * s), G1.ZERO))

  return { A, B: B2, C, publicInputs: w.slice(0, NUM_PUBLIC) }
}

/**
 * Проверка: e(A, B) == e(alpha, beta) * e(IC, gamma) * e(C, delta).
 * Записано как произведение, равное единице, — ровно так это считает и
 * прекомпайл 0x08 в EVM.
 */
export function verify(verifyingKey, proof) {
  const ic = msm(verifyingKey.icG1, proof.publicInputs, G1.ZERO)

  const product = bn254.pairingBatch([
    { g1: proof.A.negate(), g2: proof.B },
    { g1: verifyingKey.alphaG1, g2: verifyingKey.betaG2 },
    { g1: ic, g2: verifyingKey.gammaG2 },
    { g1: proof.C, g2: verifyingKey.deltaG2 },
  ])

  return Fp12.eql(product, Fp12.ONE)
}

export { G1, G2, Fp12 }
