import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTokenList } from '../scripts/token-list-build.mjs'

const ZLP = {
  chainId: 8453,
  address: '0x3fba88b5633ff26a3969e6847b5dafa4108a6ffb',
  name: 'ZALUPA',
  symbol: 'ZLP',
  decimals: 18,
  logoURI: 'https://example.test/logo.png',
}

test('собирает список по схеме Uniswap', () => {
  const { list, warnings, error } = buildTokenList(ZLP)

  assert.ok(!error)
  assert.deepEqual(warnings, [])
  assert.equal(list.tokens.length, 1)
  assert.equal(list.tokens[0].chainId, 8453)
  assert.equal(list.tokens[0].name, 'ZALUPA')
  assert.equal(list.tokens[0].symbol, 'ZLP')
  assert.equal(list.tokens[0].decimals, 18)
})

test('адрес приводится к EIP-55: список с нижним регистром не принимают', () => {
  const { list } = buildTokenList(ZLP)

  assert.equal(list.tokens[0].address, '0x3fbA88B5633FF26A3969e6847b5dAFa4108a6FFB')
  assert.notEqual(list.tokens[0].address, ZLP.address, 'должен отличаться от переданного нижнего регистра')
})

test('имя списка по умолчанию из тикера, а не из другого токена', () => {
  const { list } = buildTokenList(ZLP)
  assert.equal(list.name, 'ZLP List')

  const named = buildTokenList({ ...ZLP, listName: 'Своё имя' })
  assert.equal(named.list.name, 'Своё имя')
})

test('структурно битый адрес отбивается', () => {
  assert.match(buildTokenList({ ...ZLP, address: '0xabc' }).error, /не проходит проверку/)
  assert.match(buildTokenList({ ...ZLP, address: 'не адрес' }).error, /не проходит проверку/)
})

test('смешанный регистр нормализуется, а не отвергается', () => {
  // getAddress в viem только пересчитывает регистр. Строгая проверка контрольной
  // суммы — в address.mjs, до попадания сюда: адрес в список приходит уже разобранным.
  const { list, error } = buildTokenList({ ...ZLP, address: '0x3fBA88B5633FF26A3969e6847b5dAFa4108a6FFB' })

  assert.ok(!error)
  assert.equal(list.tokens[0].address, '0x3fbA88B5633FF26A3969e6847b5dAFa4108a6FFB')
})

test('обязательные поля проверяются', () => {
  assert.match(buildTokenList({ ...ZLP, chainId: 0 }).error, /chainId/)
  assert.match(buildTokenList({ ...ZLP, name: '' }).error, /нет имени/)
  assert.match(buildTokenList({ ...ZLP, symbol: '' }).error, /нет тикера/)
  assert.match(buildTokenList({ ...ZLP, decimals: 300 }).error, /decimals/)
})

test('тикер вне схемы предупреждает, но список собирается', () => {
  const { list, warnings } = buildTokenList({ ...ZLP, symbol: 'ZL P' })

  assert.ok(list, 'список всё равно нужен: решать пользователю')
  assert.ok(warnings.some((w) => /не соответствует схеме/.test(w)))
})

test('$$K.1 схему проходит без предупреждений', () => {
  const { warnings } = buildTokenList({ ...ZLP, symbol: '$$K.1', name: '$$K.1' })
  assert.deepEqual(warnings, [])
})

test('слишком длинные имя и тикер предупреждают', () => {
  assert.ok(buildTokenList({ ...ZLP, symbol: 'S'.repeat(21) }).warnings.some((w) => /до 20/.test(w)))
  assert.ok(buildTokenList({ ...ZLP, name: 'n'.repeat(41) }).warnings.some((w) => /до 40/.test(w)))
})

test('без логотипа предупреждает про серый кружок', () => {
  const { list, warnings } = buildTokenList({ ...ZLP, logoURI: undefined })

  assert.ok(warnings.some((w) => /серый кружок/.test(w)))
  assert.equal(list.tokens[0].logoURI, undefined, 'пустое поле не должно попадать в список')
})

test('логотип не по https предупреждает', () => {
  const { warnings } = buildTokenList({ ...ZLP, logoURI: 'http://example.test/logo.png' })
  assert.ok(warnings.some((w) => /https/.test(w)))
})

test('версия и метка времени попадают в список', () => {
  const { list } = buildTokenList({ ...ZLP, timestamp: '2026-08-16T00:00:00.000Z', version: { major: 2, minor: 1, patch: 0 } })

  assert.equal(list.timestamp, '2026-08-16T00:00:00.000Z')
  assert.deepEqual(list.version, { major: 2, minor: 1, patch: 0 })
})
