// Верификация исходников на Etherscan/Basescan через Etherscan V2 API.
// Без неё на explorer-е виден только байткод, и контракт выглядит как чёрный ящик.
//
//   ETHERSCAN_API_KEY=... TOKEN_ADDRESS=0x... CHAIN=base node scripts/verify.mjs
//
// Ключ бесплатный: etherscan.io/myapikey (один ключ работает для всех сетей V2).
//
// Аргументы конструктора не задаются руками: они читаются из транзакции создания
// контракта обычным RPC. Угадывать их по дефолтам нельзя — разойдутся с реальным
// деплоем хоть в одном символе, и верификация отклоняется без объяснений.
// Платный getcontractcreation у Etherscan для этого не нужен.
import * as chains from 'viem/chains'
import { createPublicClient, isAddress, getAddress, decodeAbiParameters } from 'viem'
import { artifact } from '../test/harness.mjs'
import { buildStandardInput, SOLC_VERSION } from './standard-input.mjs'
import { addressFrom } from './address.mjs'
import { findCreation } from './creation.mjs'
import { buildVerifyRequest, buildStatusRequest, buildSourceRequest, classifyStatus } from './verify-request.mjs'
import { transportFor } from './rpc.mjs'

const { ETHERSCAN_API_KEY, TOKEN_ADDRESS, CHAIN = 'base', RPC_URL } = process.env

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

if (!ETHERSCAN_API_KEY) fail('нужен ETHERSCAN_API_KEY — бесплатный ключ с etherscan.io/myapikey')
const parsedAddress = addressFrom({ argv: process.argv.slice(2), env: TOKEN_ADDRESS })
if (parsedAddress.error) fail(parsedAddress.error)

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}"`)

const address = parsedAddress.address

console.log(`сеть:      ${chain.name} (${chain.id})`)
console.log(`контракт:  ${address}`)

// Etherscan сопоставляет байткод и помечает верифицированным любой контракт с
// тем же кодом. Поэтому второй токен из того же исходника оказывается
// верифицирован сам собой — проверяем до отправки.
const existing = await (await fetch(buildSourceRequest({ chainId: chain.id, apiKey: ETHERSCAN_API_KEY, address })))
  .json()
  .catch(() => null)

const alreadyVerified = existing?.status === '1' && String(existing.result?.[0]?.SourceCode ?? '') !== ''
if (alreadyVerified) {
  const explorer = chain.blockExplorers?.default?.url
  console.log(`\nисходники уже верифицированы — Etherscan сопоставил байткод сам.`)
  console.log(`контракт: ${existing.result[0].ContractName}`)
  if (explorer) console.log(`${explorer}/address/${address}#code`)
  process.exit(0)
}

// ---------- аргументы конструктора из транзакции создания ----------
const { abi, bytecode } = artifact('FixedSupplyToken')
const publicClient = createPublicClient({ chain, transport: transportFor(chain, RPC_URL) })

process.stdout.write('ищу транзакцию создания... ')
const creation = await findCreation(publicClient, address, bytecode).catch((error) => fail(`\n${error.message}`))
console.log('нашёл')

const ctor = abi.find((item) => item.type === 'constructor')
const [name, symbol, decimals, supply, holder] = decodeAbiParameters(ctor.inputs, `0x${creation.constructorArgs}`)

console.log(`блок:      ${creation.blockNumber}`)
console.log(`tx:        ${creation.txHash}`)
console.log(`деплоер:   ${creation.creator}`)
console.log(`\nаргументы конструктора, прочитанные из сети:`)
console.log(`  name     "${name}"`)
console.log(`  symbol   "${symbol}"`)
console.log(`  decimals ${decimals}`)
console.log(`  supply   ${supply / 10n ** BigInt(decimals)} целых`)
console.log(`  holder   ${holder}`)

const standardInput = buildStandardInput()
console.log(`\nисходники: ${Object.keys(standardInput.sources).length} файлов`)
console.log(`solc:      ${SOLC_VERSION}\n`)

const request = buildVerifyRequest({
  chainId: chain.id,
  apiKey: ETHERSCAN_API_KEY,
  address,
  standardInput,
  constructorArgs: creation.constructorArgs,
})

const submit = await (await fetch(request.url, { method: 'POST', body: request.body })).json()
if (submit.status !== '1') fail(`не приняли на верификацию: ${submit.result}`)

const guid = submit.result
console.log(`отправлено, guid ${guid}`)
process.stdout.write('жду результат')

// Проверка идёт на их стороне, обычно 10-40 секунд.
for (let attempt = 0; attempt < 30; attempt++) {
  await new Promise((done) => setTimeout(done, 5000))
  process.stdout.write('.')

  const status = buildStatusRequest({ chainId: chain.id, apiKey: ETHERSCAN_API_KEY, guid })
  const check = await (await fetch(status)).json()
  const verdict = classifyStatus(check)

  if (verdict === 'pending') continue
  console.log('')

  const explorer = chain.blockExplorers?.default?.url
  if (verdict === 'success' || verdict === 'already') {
    console.log(verdict === 'already' ? `\nуже верифицирован: Etherscan сопоставил байткод` : `\nготово: ${check.result}`)
    if (explorer) console.log(`${explorer}/address/${address}#code`)
    process.exit(0)
  }
  fail(`\nне прошло: ${check.result}`)
}

fail('\nтаймаут — проверь статус вручную на explorer-е')
