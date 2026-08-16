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
import { createPublicClient, http, isAddress, getAddress, decodeAbiParameters } from 'viem'
import { artifact } from '../test/harness.mjs'
import { buildStandardInput, SOLC_VERSION } from './standard-input.mjs'
import { findCreation } from './creation.mjs'

const API = 'https://api.etherscan.io/v2/api'

const { ETHERSCAN_API_KEY, TOKEN_ADDRESS, CHAIN = 'base', RPC_URL } = process.env

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

if (!ETHERSCAN_API_KEY) fail('нужен ETHERSCAN_API_KEY — бесплатный ключ с etherscan.io/myapikey')
if (!TOKEN_ADDRESS || !isAddress(TOKEN_ADDRESS)) fail('нужен TOKEN_ADDRESS=0x... — адрес контракта')

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}"`)

const address = getAddress(TOKEN_ADDRESS)

console.log(`сеть:      ${chain.name} (${chain.id})`)
console.log(`контракт:  ${address}`)

// ---------- аргументы конструктора из транзакции создания ----------
const { abi, bytecode } = artifact('FixedSupplyToken')
const publicClient = createPublicClient({ chain, transport: http(RPC_URL || chain.rpcUrls.default.http[0]) })

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

const body = new URLSearchParams({
  chainid: String(chain.id),
  module: 'contract',
  action: 'verifysourcecode',
  apikey: ETHERSCAN_API_KEY,
  contractaddress: address,
  sourceCode: JSON.stringify(standardInput),
  codeformat: 'solidity-standard-json-input',
  contractname: 'contracts/FixedSupplyToken.sol:FixedSupplyToken',
  compilerversion: SOLC_VERSION,
  constructorArguements: creation.constructorArgs, // опечатка в имени — со стороны API
})

const submit = await (await fetch(API, { method: 'POST', body })).json()
if (submit.status !== '1') fail(`не приняли на верификацию: ${submit.result}`)

const guid = submit.result
console.log(`отправлено, guid ${guid}`)
process.stdout.write('жду результат')

// Проверка идёт на их стороне, обычно 10-40 секунд.
for (let attempt = 0; attempt < 30; attempt++) {
  await new Promise((done) => setTimeout(done, 5000))
  process.stdout.write('.')

  const query = new URLSearchParams({
    chainid: String(chain.id),
    module: 'contract',
    action: 'checkverifystatus',
    guid,
    apikey: ETHERSCAN_API_KEY,
  })
  const check = await (await fetch(`${API}?${query}`)).json()

  if (check.result === 'Pending in queue') continue
  console.log('')

  if (check.status === '1') {
    const explorer = chain.blockExplorers?.default?.url
    console.log(`\nготово: ${check.result}`)
    if (explorer) console.log(`${explorer}/address/${getAddress(TOKEN_ADDRESS)}#code`)
    process.exit(0)
  }
  fail(`\nне прошло: ${check.result}`)
}

fail('\nтаймаут — проверь статус вручную на explorer-е')
