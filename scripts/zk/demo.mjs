// Демонстрация всей цепочки: схема -> R1CS -> QAP -> Groth16 -> проверка в EVM.
//
//   node scripts/zk/demo.mjs [секрет]
//
// Сети не требуется: EVM поднимается в памяти.
import { createChain, deploy } from '../../test/harness.mjs'
import { setup, prove, verify } from './groth16.mjs'
import { verifyingKeyToCalldata, proofToCalldata } from './calldata.mjs'
import { witness, satisfiesR1CS, toQAP, quotient, CONSTRAINTS, WIRES } from './circuit.mjs'
import { degree, evaluate, mod } from './poly.mjs'

const secret = BigInt(process.argv[2] ?? 3)
const out = mod(secret ** 3n + secret + 5n)

const line = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`)

console.log(`\nУТВЕРЖДЕНИЕ`)
console.log(`  Я знаю x, для которого x^3 + x + 5 = ${out}.`)
console.log(`  Проверяющий узнаёт только ${out}. Сам x (${secret}) не раскрывается.`)

// ---------- R1CS ----------
console.log(`\n1. R1CS — схема как набор умножений`)
const w = witness(secret)
line('проводов', `${WIRES.length}: ${WIRES.join(', ')}`)
line('констрейнтов', CONSTRAINTS.length)
line('свидетельство сходится', satisfiesR1CS(w))

// ---------- QAP ----------
console.log(`\n2. QAP — ${CONSTRAINTS.length} констрейнтов в одно тождество`)
const qap = toQAP()
const { h, remainder, a, b, c } = quotient(qap, w)
line('степень A(x), B(x), C(x)', `${degree(a)}, ${degree(b)}, ${degree(c)}`)
line('Z(x) обнуляется в', qap.points.map(String).join(', '))
line('A*B - C делится на Z', remainder.length === 0 ? 'да, без остатка' : 'НЕТ')
line('степень H(x)', degree(h))

const probe = 999983n
line(`тождество в точке ${probe}`, mod(evaluate(a, probe) * evaluate(b, probe) - evaluate(c, probe)) === mod(evaluate(h, probe) * evaluate(qap.Z, probe)))

// ---------- Groth16 ----------
console.log(`\n3. Groth16`)
const t0 = performance.now()
const keys = setup()
const t1 = performance.now()
const proof = prove(keys, secret)
const t2 = performance.now()
const okJs = verify(keys.verifyingKey, proof)
const t3 = performance.now()

line('доверенная настройка', `${(t1 - t0).toFixed(0)} ms`)
line('доказательство', `${(t2 - t1).toFixed(0)} ms`)
line('проверка в JS', `${(t3 - t2).toFixed(0)} ms — ${okJs}`)
line('размер доказательства', '8 полевых элементов = 256 байт')
line('публичные входы', proof.publicInputs.map(String).join(', '))

// ---------- EVM ----------
console.log(`\n4. Проверка контрактом на прекомпайлах`)
const chain = await createChain(['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'])
const [account] = chain.accounts
const verifier = await deploy(chain, 'Groth16Verifier', verifyingKeyToCalldata(keys.verifyingKey))

const calldata = proofToCalldata(proof)
const okEvm = await verifier.read('verify', calldata)
const receipt = await verifier.write(account, 'verify', calldata)

line('верификатор', verifier.address)
line('результат', okEvm)
line('газ', `${receipt.gasUsed} — не зависит от размера схемы`)

// ---------- стойкость ----------
console.log(`\n5. Попытки соврать`)
const [pa, pb, pc] = calldata
line(`заявить out = ${out + 1n}`, await verifier.read('verify', [pa, pb, pc, [1n, out + 1n]]))
line('подменить точку A', await verifier.read('verify', [proofToCalldata({ ...proof, A: proof.A.double() })[0], pb, pc, calldata[3]]))

const other = setup()
line('доказательство от чужой настройки', verify(keys.verifyingKey, prove(other, secret)))

console.log(`\nВывод: ${WIRES.length} проводов и ${CONSTRAINTS.length} констрейнта свернулись в 256 байт,`)
console.log(`которые проверяются за ${receipt.gasUsed} газа, не раскрывая x.\n`)
