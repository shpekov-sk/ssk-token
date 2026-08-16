// Тесты сборки запросов к Etherscan V2. Без ключа и без сети: проверяется ровно
// то, на чём верификация уже спотыкалась — где именно лежат параметры.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVerifyRequest,
  buildStatusRequest,
  buildSourceRequest,
  classifyStatus,
  CONTRACT_NAME,
  API,
} from '../scripts/verify-request.mjs'
import { buildStandardInput, SOLC_VERSION } from '../scripts/standard-input.mjs'

const BASE = {
  chainId: 8453,
  apiKey: 'test-key',
  address: '0x72883511A0B1dE1fF1cA0669D0C3dE699D56c0a8',
  standardInput: { language: 'Solidity', sources: {}, settings: {} },
  constructorArgs: 'deadbeef',
}

test('chainid уходит в query — V2 игнорирует его в теле POST', () => {
  const { url } = buildVerifyRequest(BASE)
  const params = new URL(url).searchParams

  assert.equal(params.get('chainid'), '8453')
  assert.equal(params.get('module'), 'contract')
  assert.equal(params.get('action'), 'verifysourcecode')
})

test('ключ уходит в тело, а не в URL', () => {
  const { url, body } = buildVerifyRequest(BASE)

  assert.equal(new URL(url).searchParams.get('apikey'), null, 'ключ не должен попадать в query')
  assert.equal(body.get('apikey'), 'test-key')
})

test('тело содержит всё, что нужно explorer-у', () => {
  const { body } = buildVerifyRequest(BASE)

  assert.equal(body.get('contractaddress'), BASE.address)
  assert.equal(body.get('codeformat'), 'solidity-standard-json-input')
  assert.equal(body.get('contractname'), CONTRACT_NAME)
  assert.equal(body.get('compilerversion'), SOLC_VERSION)
  assert.equal(body.get('constructorArguements'), 'deadbeef', 'имя поля с опечаткой — так у API')
  assert.equal(JSON.parse(body.get('sourceCode')).language, 'Solidity')
})

test('имя контракта указывает на реально существующий файл в standard input', () => {
  const input = buildStandardInput()
  const [file] = CONTRACT_NAME.split(':')

  assert.ok(input.sources[file], `${file} нет среди исходников: ${Object.keys(input.sources).join(', ')}`)
})

test('запрос статуса тоже несёт chainid в query', () => {
  const url = buildStatusRequest({ chainId: 8453, apiKey: 'test-key', guid: 'abc123' })
  const params = new URL(url).searchParams

  assert.ok(url.startsWith(API))
  assert.equal(params.get('chainid'), '8453')
  assert.equal(params.get('action'), 'checkverifystatus')
  assert.equal(params.get('guid'), 'abc123')
})

test('пустые аргументы конструктора не ломают запрос', () => {
  const { body } = buildVerifyRequest({ ...BASE, constructorArgs: '' })
  assert.equal(body.get('constructorArguements'), '')
})

test('«Already Verified» — это успех, а не провал', () => {
  // Приходит со status '0', и на этом скрипт однажды напечатал «не прошло».
  assert.equal(classifyStatus({ status: '0', result: 'Already Verified' }), 'already')
  assert.equal(classifyStatus({ status: '1', result: 'Already Verified' }), 'already')
})

test('очередь отличается от результата', () => {
  assert.equal(classifyStatus({ status: '0', result: 'Pending in queue' }), 'pending')
})

test('успех и провал различаются по статусу', () => {
  assert.equal(classifyStatus({ status: '1', result: 'Pass - Verified' }), 'success')
  assert.equal(classifyStatus({ status: '0', result: 'Fail - Unable to verify' }), 'failed')
})

test('пустой ответ считается провалом, а не успехом', () => {
  assert.equal(classifyStatus(undefined), 'failed')
  assert.equal(classifyStatus({}), 'failed')
})

test('запрос исходников несёт chainid в query и адрес', () => {
  const url = buildSourceRequest({ chainId: 8453, apiKey: 'k', address: '0xabc' })
  const params = new URL(url).searchParams

  assert.equal(params.get('chainid'), '8453')
  assert.equal(params.get('action'), 'getsourcecode')
  assert.equal(params.get('address'), '0xabc')
})
