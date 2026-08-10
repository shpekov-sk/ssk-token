// Прогон scripts/deploy.mjs целиком против локального EVM: fetch перехвачен,
// JSON-RPC обслуживается в процессе. Ловит ошибки в самом скрипте деплоя —
// те, что иначе вылезут только на настоящей транзакции в мейннете.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createChain } from './harness.mjs'
import { createTxFromRLP } from '@ethereumjs/tx'
import { runTx } from '@ethereumjs/vm'
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RPC = 'http://127.0.0.1:8545'

const hex = (value) => `0x${BigInt(value).toString(16)}`

/** Поднимает in-process JSON-RPC поверх EVM и подменяет globalThis.fetch. */
async function withMockRpc(run, chainId = 8453) {
  // viem подписывает транзакцию для конкретной сети — VM должна ждать тот же chainId,
  // иначе подпись не проходит валидацию и деплой падает уже на отправке.
  const chain = await createChain([KEY], { chainId })
  const receipts = new Map()
  const addr = (value) => createAddressFromString(value.toLowerCase())

  const methods = {
    eth_chainId: () => hex(chainId),
    net_version: () => String(chainId),
    eth_blockNumber: () => hex(1),
    eth_getBalance: async ([address]) => hex((await chain.vm.stateManager.getAccount(addr(address)))?.balance ?? 0n),
    eth_getTransactionCount: async ([a]) => hex((await chain.vm.stateManager.getAccount(addr(a)))?.nonce ?? 0n),
    eth_gasPrice: () => hex(20_000_000n),
    eth_maxPriorityFeePerGas: () => hex(1_000_000n),
    eth_getBlockByNumber: () => ({ number: hex(1), baseFeePerGas: hex(7), timestamp: hex(1), gasLimit: hex(30_000_000) }),
    // Оценка CREATE через evm.runCall не воспроизводится один-в-один, а тесту важен
    // не сам прогноз, а что скрипт доходит до отправки: реальный газ приедет в receipt.
    eth_estimateGas: () => hex(2_000_000n),
    eth_sendRawTransaction: async ([raw]) => {
      // createTxFromRLP разбирает любой тип: viem на Base шлёт EIP-1559 (0x02).
      const tx = createTxFromRLP(hexToBytes(raw), { common: chain.common })
      const result = await runTx(chain.vm, { tx, skipBalance: true, skipBlockGasLimitValidation: true })
      const hash = bytesToHex(tx.hash())
      receipts.set(hash, {
        transactionHash: hash,
        blockNumber: hex(1),
        blockHash: `0x${'11'.repeat(32)}`,
        transactionIndex: hex(0),
        from: tx.getSenderAddress().toString(),
        to: null,
        contractAddress: result.createdAddress?.toString() ?? null,
        status: result.execResult.exceptionError ? '0x0' : '0x1',
        gasUsed: hex(result.totalGasSpent),
        cumulativeGasUsed: hex(result.totalGasSpent),
        effectiveGasPrice: hex(tx.gasPrice ?? tx.maxFeePerGas ?? 0n),
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        type: '0x0',
      })
      return hash
    },
    eth_getTransactionReceipt: ([hash]) => receipts.get(hash) ?? null,
    eth_feeHistory: () => ({ oldestBlock: hex(1), baseFeePerGas: [hex(7), hex(7)], gasUsedRatio: [0.5], reward: [[hex(1_000_000n)]] }),
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    const batch = Array.isArray(body) ? body : [body]
    const responses = await Promise.all(
      batch.map(async ({ id, method, params }) => {
        const handler = methods[method]
        if (!handler) return { jsonrpc: '2.0', id, error: { code: -32601, message: `no mock for ${method}` } }
        try {
          return { jsonrpc: '2.0', id, result: await handler(params ?? []) }
        } catch (error) {
          return { jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }
        }
      }),
    )
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    return await run(chain)
  } finally {
    globalThis.fetch = realFetch
  }
}

let runCounter = 0

/** Запускает deploy.mjs в этом же процессе, собирая его stdout. */
async function runDeploy(env, stdinAnswer) {
  const runId = ++runCounter
  const savedEnv = { ...process.env }
  const savedExit = process.exit
  const savedLog = console.log
  const savedError = console.error
  const output = []

  Object.assign(process.env, { RPC_URL: RPC, PRIVATE_KEY: KEY, ...env })
  console.log = (...args) => output.push(args.join(' '))
  console.error = (...args) => output.push(args.join(' '))

  let exitCode = null
  process.exit = (code) => {
    exitCode = code
    throw new Error('__exit__')
  }

  // Мейннет-путь запрашивает подтверждение через readline — подставляем ответ.
  const savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  if (stdinAnswer !== undefined) {
    const { Readable } = await import('node:stream')
    Object.defineProperty(process, 'stdin', { value: Readable.from([`${stdinAnswer}\n`]), configurable: true })
  }

  try {
    // Свежий импорт на каждый прогон: скрипт исполняется на верхнем уровне модуля,
    // а одинаковый query вернул бы закешированный модуль и тест бы ничего не проверил.
    await import(`../scripts/deploy.mjs?run=${runId}`)
  } catch (error) {
    if (error.message !== '__exit__') throw error
  } finally {
    process.exit = savedExit
    console.log = savedLog
    console.error = savedError
    process.env = savedEnv
    if (savedStdin) Object.defineProperty(process, 'stdin', savedStdin)
  }

  return { text: output.join('\n'), exitCode }
}

test('деплой проходит до конца и возвращает адрес контракта', async () => {
  const { text, exitCode } = await withMockRpc(() =>
    runDeploy({ CHAIN: 'base', CONFIRM: 'yes', TOKEN_SYMBOL: '$$K.1' }, '$$K.1'),
  )

  assert.equal(exitCode, null, `скрипт упал:\n${text}`)
  assert.match(text, /Base \(chainId 8453\)/)
  assert.match(text, /газ:\s+\d+/, 'нет оценки газа — она обязана считаться до отправки')
  assert.match(text, /контракт:\s+0x[0-9a-fA-F]{40}/, `нет адреса контракта:\n${text}`)
  assert.match(text, /explorer:\s+https:\/\/basescan\.org/)
})

test('мейннет без CONFIRM останавливается до отправки транзакции', async () => {
  const { text, exitCode } = await withMockRpc(() => runDeploy({ CHAIN: 'base' }))

  assert.equal(exitCode, 1)
  assert.match(text, /нужен CONFIRM=yes/)
  assert.doesNotMatch(text, /отправляю/, 'транзакция не должна была уйти')
})

test('неверный ответ на подтверждение отменяет деплой', async () => {
  const { text, exitCode } = await withMockRpc(() =>
    runDeploy({ CHAIN: 'base', CONFIRM: 'yes', TOKEN_SYMBOL: '$$K.1' }, 'что-то не то'),
  )

  assert.equal(exitCode, 1)
  assert.match(text, /не совпало/)
  assert.doesNotMatch(text, /отправляю/)
})

test('тестнет деплоится без подтверждений', async () => {
  const { text, exitCode } = await withMockRpc(() => runDeploy({ CHAIN: 'baseSepolia' }), 84532)

  assert.equal(exitCode, null, `скрипт упал:\n${text}`)
  assert.match(text, /тестовая/)
  assert.match(text, /контракт:\s+0x[0-9a-fA-F]{40}/)
})
