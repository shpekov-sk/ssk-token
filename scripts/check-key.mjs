// Проверка ключа без отправки транзакций: печатает адрес и балансы.
// Адрес — публичная информация, сам ключ не выводится.
//
//   PRIVATE_KEY=... npm run check-key
import { createPublicClient, http, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { normalizePrivateKey } from './key.mjs'

const parsed = normalizePrivateKey(process.env.PRIVATE_KEY)
if (parsed.error) {
  console.error(`ключ не подходит: ${parsed.error}`)
  process.exit(1)
}

const account = privateKeyToAccount(parsed.key)
console.log(`ключ разобран, адрес: ${account.address}\n`)

const NETWORKS = ['base', 'linea', 'optimism', 'arbitrum', 'mainnet', 'baseSepolia']
const DEPLOY_GAS = 1_029_341n

for (const name of NETWORKS) {
  const chain = chains[name]
  const client = createPublicClient({ chain, transport: http() })
  try {
    const [balance, fees] = await Promise.all([
      client.getBalance({ address: account.address }),
      client.estimateFeesPerGas().catch(() => ({})),
    ])
    const price = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
    const cost = DEPLOY_GAS * price
    const verdict = balance === 0n ? 'пусто' : cost > 0n && balance < cost ? 'НЕ ХВАТИТ на деплой' : 'хватит'
    console.log(
      `${chain.name.padEnd(16)} ${formatEther(balance).padStart(12)} ${chain.nativeCurrency.symbol}` +
        `   деплой ~${formatEther(cost)}   ${verdict}`,
    )
  } catch (error) {
    console.log(`${chain.name.padEnd(16)} RPC недоступен (${error.shortMessage ?? error.message})`)
  }
}
