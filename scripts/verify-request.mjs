// Сборка запросов к Etherscan V2 API. Вынесено из verify.mjs, чтобы это можно
// было проверить тестами без ключа и без сети.
//
// Главная тонкость V2: chainid обязателен в query-строке. В теле POST он
// игнорируется, а в ответ приходит «Missing or unsupported chainid parameter»,
// без намёка на то, что параметр не там.
import { SOLC_VERSION } from './standard-input.mjs'

export const API = 'https://api.etherscan.io/v2/api'
export const CONTRACT_NAME = 'contracts/FixedSupplyToken.sol:FixedSupplyToken'

export function buildVerifyRequest({ chainId, apiKey, address, standardInput, constructorArgs }) {
  const url = `${API}?${new URLSearchParams({
    chainid: String(chainId),
    module: 'contract',
    action: 'verifysourcecode',
  })}`

  const body = new URLSearchParams({
    apikey: apiKey,
    chainid: String(chainId),
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: address,
    sourceCode: JSON.stringify(standardInput),
    codeformat: 'solidity-standard-json-input',
    contractname: CONTRACT_NAME,
    compilerversion: SOLC_VERSION,
    constructorArguements: constructorArgs, // опечатка в имени — со стороны API
  })

  return { url, body }
}

export function buildStatusRequest({ chainId, apiKey, guid }) {
  return `${API}?${new URLSearchParams({
    chainid: String(chainId),
    module: 'contract',
    action: 'checkverifystatus',
    guid,
    apikey: apiKey,
  })}`
}
