// Проверка ключевого допущения концепта: «хэш первой транзакции полностью случаен,
// предугадать невозможно». Считаем, сколько разных TxID можно намолотить офлайн
// на один и тот же адрес, ничего не отправляя в сеть и не платя газ.
//
// Отправитель свободно меняет gasLimit, maxFeePerGas, value, calldata — подпись и
// хэш меняются целиком. Ни один из вариантов не уходит в сеть, пока не найден нужный.
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256 } from 'viem'
import { randomBytes } from 'node:crypto'

const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`)
const seen = new Set()

const base = {
  chainId: 8453, // Base
  nonce: 0, // именно первая транзакция кошелька
  to: '0x4200000000000000000000000000000000000006',
  value: 0n,
  maxFeePerGas: 1_000_000n,
  maxPriorityFeePerGas: 100_000n,
  type: 'eip1559',
}

const N = 20_000
const t0 = Date.now()

for (let i = 0; i < N; i++) {
  // Единственное отличие между попытками — лимит газа. Транзакция остаётся валидной.
  const signed = await account.signTransaction({ ...base, gas: 21_000n + BigInt(i) })
  seen.add(keccak256(signed))
}

const secs = (Date.now() - t0) / 1000
console.log(`адрес:            ${account.address}`)
console.log(`подписано:        ${N.toLocaleString('ru')} вариантов первой транзакции`)
console.log(`разных TxID:      ${seen.size.toLocaleString('ru')}`)
console.log(`скорость:         ${Math.round(N / secs).toLocaleString('ru')} вариантов/сек на одном ядре`)
console.log(`потрачено газа:   0 — ни одна не отправлена`)
console.log(`\nВ сеть уходит только выигравшая: один tx, одна комиссия.`)
