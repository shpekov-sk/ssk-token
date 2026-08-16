// Перевод точек кривой в формат, который ждёт EVM.
//
// Тонкость EIP-197: элемент Fp2 кодируется мнимой частью вперёд, то есть
// c1 идёт перед c0. Перепутать легко, а проявится это тем, что прекомпайл
// сочтёт точку не лежащей на кривой и откажет без объяснений.
import { G1, G2 } from './groth16.mjs'

/** G1: [x, y]. Точка на бесконечности кодируется как [0, 0]. */
export function g1ToCalldata(point) {
  if (point.is0()) return [0n, 0n]
  const { x, y } = point.toAffine()
  return [x, y]
}

/** G2: [x.c1, x.c0, y.c1, y.c0] — мнимая часть первой. */
export function g2ToCalldata(point) {
  if (point.is0()) return [0n, 0n, 0n, 0n]
  const { x, y } = point.toAffine()
  return [x.c1, x.c0, y.c1, y.c0]
}

/** Аргументы конструктора верификатора из ключа проверки. */
export function verifyingKeyToCalldata(verifyingKey) {
  return [
    g1ToCalldata(verifyingKey.alphaG1),
    g2ToCalldata(verifyingKey.betaG2),
    g2ToCalldata(verifyingKey.gammaG2),
    g2ToCalldata(verifyingKey.deltaG2),
    verifyingKey.icG1.map(g1ToCalldata),
  ]
}

/** Аргументы вызова verify из доказательства. */
export function proofToCalldata(proof) {
  return [g1ToCalldata(proof.A), g2ToCalldata(proof.B), g1ToCalldata(proof.C), proof.publicInputs]
}

export { G1, G2 }
