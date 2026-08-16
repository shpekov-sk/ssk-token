import test from 'node:test'
import assert from 'node:assert/strict'
import { base, baseSepolia, mainnet } from 'viem/chains'
import { endpointsFor, transportFor } from '../scripts/rpc.mjs'

test('свой узел идёт первым — иначе он бесполезен', () => {
  const endpoints = endpointsFor(base, 'https://my-node.example/rpc')
  assert.equal(endpoints[0], 'https://my-node.example/rpc')
})

test('без своего узла первым идёт дефолтный из viem', () => {
  const endpoints = endpointsFor(base)
  assert.equal(endpoints[0], base.rpcUrls.default.http[0].replace(/\/+$/, ''))
})

test('запасные узлы добавляются — на одном публичном RPC мы упирались в rate limit', () => {
  const endpoints = endpointsFor(base)
  assert.ok(endpoints.length >= 4, `узлов должно быть с запасом, а их ${endpoints.length}`)
})

test('дубли не тратят попытки фолбэка', () => {
  const official = base.rpcUrls.default.http[0]
  const endpoints = endpointsFor(base, official)

  assert.equal(new Set(endpoints).size, endpoints.length)
  assert.equal(endpoints.filter((url) => url === official.replace(/\/+$/, '')).length, 1)
})

test('хвостовой слеш не создаёт второй "разный" узел', () => {
  const endpoints = endpointsFor(base, `${base.rpcUrls.default.http[0]}/`)
  assert.equal(new Set(endpoints).size, endpoints.length)
})

test('для сети без запасных узлов список всё равно рабочий', () => {
  const endpoints = endpointsFor(mainnet)
  assert.ok(endpoints.length >= 1)
  assert.ok(endpoints.every((url) => url.startsWith('http')))
})

test('тестнет тоже прикрыт запасными', () => {
  assert.ok(endpointsFor(baseSepolia).length >= 2)
})

test('транспорт собирается и умеет повторы', () => {
  const transport = transportFor(base)
  const config = transport({ chain: base }).config

  assert.equal(config.type, 'fallback')
  assert.ok(config.retryCount >= 1)
})
