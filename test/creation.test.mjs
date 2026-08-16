// Тесты поиска транзакции создания на заглушке клиента: сеть тут не нужна,
// проверяется логика бинарного поиска и извлечения аргументов.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findCreation } from '../scripts/creation.mjs'

const ADDRESS = '0x72883511A0B1dE1fF1cA0669D0C3dE699D56c0a8'
const BYTECODE = '0x6080604052'
const ARGS = 'deadbeef'.repeat(8)

/**
 * Клиент-заглушка: код появляется начиная с deployBlock, в этом же блоке лежит
 * транзакция деплоя. Считает вызовы, чтобы поймать линейный перебор вместо поиска.
 */
function stubClient({ latest, deployBlock, transactions, input = BYTECODE + ARGS }) {
  const calls = { getCode: 0 }
  return {
    calls,
    getBlockNumber: async () => latest,
    getCode: async ({ blockNumber }) => {
      calls.getCode++
      return blockNumber >= deployBlock ? '0x60806040' : '0x'
    },
    getBlock: async ({ blockNumber }) => ({
      number: blockNumber,
      transactions:
        transactions ??
        (blockNumber === deployBlock
          ? [{ hash: '0xtx', to: null, from: '0xcreator', input }]
          : []),
    }),
    getTransactionReceipt: async () => ({ contractAddress: ADDRESS }),
  }
}

test('находит блок деплоя и вытаскивает аргументы конструктора', async () => {
  const client = stubClient({ latest: 30_000_000n, deployBlock: 21_345_678n })

  const result = await findCreation(client, ADDRESS, BYTECODE)

  assert.equal(result.blockNumber, 21_345_678n)
  assert.equal(result.txHash, '0xtx')
  assert.equal(result.creator, '0xcreator')
  assert.equal(result.constructorArgs, ARGS)
})

test('ищет бинарно, а не перебором', async () => {
  const client = stubClient({ latest: 30_000_000n, deployBlock: 21_345_678n })

  await findCreation(client, ADDRESS, BYTECODE)

  // log2(30 млн) ~ 25; с запасом на проверки края — заведомо меньше сотни.
  assert.ok(client.calls.getCode < 100, `слишком много вызовов getCode: ${client.calls.getCode}`)
})

test('работает, когда контракт в самом первом блоке', async () => {
  const client = stubClient({ latest: 100n, deployBlock: 0n })
  const result = await findCreation(client, ADDRESS, BYTECODE)
  assert.equal(result.blockNumber, 0n)
})

test('работает, когда контракт задеплоен последним блоком', async () => {
  const client = stubClient({ latest: 1000n, deployBlock: 1000n })
  const result = await findCreation(client, ADDRESS, BYTECODE)
  assert.equal(result.blockNumber, 1000n)
})

test('по адресу без кода — понятная ошибка', async () => {
  const client = {
    getBlockNumber: async () => 1000n,
    getCode: async () => '0x',
  }
  await assert.rejects(() => findCreation(client, ADDRESS, BYTECODE), /нет кода/)
})

test('чужой байткод не проходит молча', async () => {
  const client = stubClient({
    latest: 1000n,
    deployBlock: 500n,
    input: '0xffffffff' + ARGS, // собрано из других исходников
  })
  await assert.rejects(() => findCreation(client, ADDRESS, BYTECODE), /не совпадает с локальной сборкой/)
})

test('деплой фабрикой — говорит, что делать', async () => {
  const client = stubClient({
    latest: 1000n,
    deployBlock: 500n,
    transactions: [{ hash: '0xother', to: '0xfactory', from: '0xdev', input: '0x1234' }],
  })
  await assert.rejects(() => findCreation(client, ADDRESS, BYTECODE), /фабрикой/)
})

test('контракт без аргументов конструктора — пустая строка, не ошибка', async () => {
  const client = stubClient({ latest: 1000n, deployBlock: 500n, input: BYTECODE })
  const result = await findCreation(client, ADDRESS, BYTECODE)
  assert.equal(result.constructorArgs, '')
})
