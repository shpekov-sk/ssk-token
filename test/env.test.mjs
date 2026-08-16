import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnv, readEnv } from '../scripts/env.mjs'

test('TARGET_PRICE принимается как TARGET_PRICE_USD — на этом уже спотыкались', () => {
  const { values, aliased } = resolveEnv({ TARGET_PRICE: '0.05' })

  assert.equal(values.TARGET_PRICE_USD, '0.05')
  assert.deepEqual(aliased, [{ from: 'TARGET_PRICE', to: 'TARGET_PRICE_USD', used: true }])
})

test('явное имя сильнее синонима', () => {
  const { values, aliased } = resolveEnv({ TARGET_PRICE: '0.05', TARGET_PRICE_USD: '0.1' })

  assert.equal(values.TARGET_PRICE_USD, '0.1')
  assert.equal(aliased[0].used, false)
})

test('опечатка в имени попадает в unknown, а не игнорируется', () => {
  const { unknown } = resolveEnv({ TOKEN_ADRESS: '0xabc', POOL_TOKEN: '100' })

  assert.ok(unknown.includes('TOKEN_ADRESS'))
  assert.ok(unknown.includes('POOL_TOKEN'))
})

test('чужие переменные окружения не трогаем', () => {
  const { unknown } = resolveEnv({ PATH: '/usr/bin', HOME: '/Users/x', LANG: 'ru_RU', SHELL: '/bin/zsh' })

  assert.deepEqual(unknown, [])
})

test('известные имена проходят как есть', () => {
  const { values, unknown, aliased } = resolveEnv({
    PRIVATE_KEY: '0x1',
    TOKEN_ADDRESS: '0x2',
    TARGET_PRICE_USD: '0.05',
    CONFIRM: 'yes',
  })

  assert.equal(values.TOKEN_ADDRESS, '0x2')
  assert.equal(values.CONFIRM, 'yes')
  assert.deepEqual(unknown, [])
  assert.deepEqual(aliased, [])
})

test('readEnv падает на непонятном имени, а не продолжает с дефолтом', () => {
  const errors = []
  readEnv({ TOKEN_ADRESS: '0xabc' }, (message) => errors.push(message))

  assert.equal(errors.length, 1)
  assert.match(errors[0], /TOKEN_ADRESS/)
  assert.match(errors[0], /Известные:/)
})

test('readEnv не шумит на чистом окружении', () => {
  const errors = []
  const values = readEnv({ TOKEN_ADDRESS: '0x2', PATH: '/bin' }, (m) => errors.push(m))

  assert.deepEqual(errors, [])
  assert.equal(values.TOKEN_ADDRESS, '0x2')
})

test('ETH_USD не путается с прочими ETH_*', () => {
  const { values, unknown } = resolveEnv({ ETH_USD: '1882', ETH_PRICE: '1882' })

  assert.equal(values.ETH_USD, '1882')
  assert.ok(unknown.includes('ETH_PRICE'), 'ETH_PRICE не наше имя — надо сказать')
})
