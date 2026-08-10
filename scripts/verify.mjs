// Верификация исходников на Etherscan/Basescan через Etherscan V2 API.
// Без неё на explorer-е виден только байткод, и контракт выглядит как чёрный ящик.
//
//   ETHERSCAN_API_KEY=... TOKEN_ADDRESS=0x... CHAIN=base node scripts/verify.mjs
//
// Ключ бесплатный: etherscan.io/myapikey (один ключ работает для всех сетей V2).
import * as chains from 'viem/chains'
import { isAddress, getAddress, encodeAbiParameters, parseUnits } from 'viem'
import { artifact } from '../test/harness.mjs'
import { buildStandardInput, SOLC_VERSION } from './standard-input.mjs'

const API = 'https://api.etherscan.io/v2/api'

const {
  ETHERSCAN_API_KEY,
  TOKEN_ADDRESS,
  CHAIN = 'base',
  TOKEN_NAME = '$$K.1',
  TOKEN_SYMBOL = '$$K.1',
  TOKEN_DECIMALS = '18',
  TOKEN_SUPPLY = '1000000',
  HOLDER,
} = process.env

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

if (!ETHERSCAN_API_KEY) fail('нужен ETHERSCAN_API_KEY — бесплатный ключ с etherscan.io/myapikey')
if (!TOKEN_ADDRESS || !isAddress(TOKEN_ADDRESS)) fail('нужен TOKEN_ADDRESS=0x... — адрес контракта')
if (!HOLDER || !isAddress(HOLDER)) fail('нужен HOLDER=0x... — адрес, получивший эмиссию при деплое')

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}"`)

const standardInput = buildStandardInput()

// Аргументы конструктора: тот же ABI-кодинг, что при деплое, но без селектора.
const { abi } = artifact('FixedSupplyToken')
const ctor = abi.find((item) => item.type === 'constructor')
const constructorArgs = encodeAbiParameters(ctor.inputs, [
  TOKEN_NAME,
  TOKEN_SYMBOL,
  Number(TOKEN_DECIMALS),
  parseUnits(TOKEN_SUPPLY, Number(TOKEN_DECIMALS)),
  getAddress(HOLDER),
]).slice(2)

console.log(`сеть:      ${chain.name} (${chain.id})`)
console.log(`контракт:  ${getAddress(TOKEN_ADDRESS)}`)
console.log(`исходники: ${Object.keys(standardInput.sources).length} файлов\n`)

const body = new URLSearchParams({
  chainid: String(chain.id),
  module: 'contract',
  action: 'verifysourcecode',
  apikey: ETHERSCAN_API_KEY,
  contractaddress: getAddress(TOKEN_ADDRESS),
  sourceCode: JSON.stringify(standardInput),
  codeformat: 'solidity-standard-json-input',
  contractname: 'contracts/FixedSupplyToken.sol:FixedSupplyToken',
  compilerversion: SOLC_VERSION,
  constructorArguements: constructorArgs, // опечатка в имени — со стороны API
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
