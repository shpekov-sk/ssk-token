// Мини-харнесс поверх @ethereumjs/vm: локальный EVM в памяти, без сети и нод.
// Даёт deploy/read/write/trySend и разбор revert-ов — этого хватает для тестов токена.
import { createVM, runTx } from '@ethereumjs/vm'
import { Common, Mainnet, Hardfork, createCustomCommon } from '@ethereumjs/common'
import { createLegacyTx } from '@ethereumjs/tx'
import {
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
  bytesToHex,
} from '@ethereumjs/util'
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  parseAbiParameters,
  parseEventLogs,
  toFunctionSelector,
} from 'viem'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function artifact(name) {
  return JSON.parse(readFileSync(join(root, 'artifacts', `${name}.json`), 'utf8'))
}

const FUNDING = 10n ** 24n // 1M ETH на каждый тестовый аккаунт

export async function createChain(privateKeys, { chainId } = {}) {
  // chainId нужен, когда транзакции подписывает внешний клиент (viem) под конкретную
  // сеть: подпись привязана к chainId, и VM должна ждать тот же самый.
  const common = chainId
    ? createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun })
    : new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
  const vm = await createVM({ common })
  const nonces = new Map()

  const accounts = []
  for (const pk of privateKeys) {
    const key = hexToBytes(pk)
    const address = createAddressFromPrivateKey(key)
    await vm.stateManager.putAccount(address, createAccount({ balance: FUNDING }))
    const account = { key, address, hex: address.toString() }
    nonces.set(account.hex, 0n)
    accounts.push(account)
  }

  async function send(from, { to, data, value = 0n }) {
    const nonce = nonces.get(from.hex) ?? 0n
    const tx = createLegacyTx(
      {
        nonce,
        gasPrice: 1_000_000_000n, // должен быть >= baseFeePerGas дефолтного блока
        gasLimit: 30_000_000n,
        to: to ? createAddressFromString(to) : undefined,
        value,
        data: hexToBytes(data),
      },
      { common },
    ).sign(from.key)

    const result = await runTx(vm, { tx, skipBalance: true, skipBlockGasLimitValidation: true })
    nonces.set(from.hex, nonce + 1n)

    const exception = result.execResult.exceptionError
    return {
      error: exception ? exception.error : null,
      returnValue: bytesToHex(result.execResult.returnValue),
      gasUsed: result.totalGasSpent,
      createdAddress: result.createdAddress?.toString() ?? null,
      logs: (result.execResult.logs ?? []).map(([address, topics, data]) => ({
        address: bytesToHex(address),
        topics: topics.map(bytesToHex),
        data: bytesToHex(data),
      })),
    }
  }

  return { vm, common, accounts, send }
}

export function contractAt(chain, abi, address) {
  const call = (from, functionName, args, value) =>
    chain.send(from, { to: address, data: encodeFunctionData({ abi, functionName, args }), value })

  return {
    address,
    abi,

    /** Транзакция, которая обязана пройти. Реверт — исключение. */
    async write(from, functionName, args = [], value = 0n) {
      const res = await call(from, functionName, args, value)
      if (res.error) throw new RevertError(functionName, res, abi)
      res.events = parseEventLogs({ abi, logs: res.logs })
      return res
    },

    /** view-вызов: тот же путь исполнения, но нас интересует только результат. */
    async read(functionName, args = [], from = chain.accounts[0]) {
      const res = await call(from, functionName, args, 0n)
      if (res.error) throw new RevertError(functionName, res, abi)
      return decodeFunctionResult({ abi, functionName, data: res.returnValue })
    },

    /** Как write, но реверт возвращается как значение — для негативных тестов. */
    async trySend(from, functionName, args = [], value = 0n) {
      const res = await call(from, functionName, args, value)
      res.revert = res.error ? decodeRevert(res.returnValue, abi) : null
      return res
    },
  }
}

export async function deploy(chain, name, args = [], from = chain.accounts[0]) {
  const { abi, bytecode } = artifact(name)
  const res = await chain.send(from, { data: encodeDeployData({ abi, bytecode, args }) })
  if (res.error) throw new Error(`deploy ${name} failed: ${res.error}`)
  return contractAt(chain, abi, res.createdAddress)
}

const ERROR_STRING_SELECTOR = '0x08c379a0'
const PANIC_SELECTOR = '0x4e487b71'

/** Разворачивает revert data в имя ошибки: Error(string), Panic(uint) или custom error из ABI. */
export function decodeRevert(returnValue, abi = []) {
  if (!returnValue || returnValue === '0x') return { name: null, args: [], raw: returnValue }

  if (returnValue.startsWith(ERROR_STRING_SELECTOR)) {
    return { name: 'Error', args: decodeArgs(['string'], returnValue), raw: returnValue }
  }
  if (returnValue.startsWith(PANIC_SELECTOR)) {
    return { name: 'Panic', args: decodeArgs(['uint256'], returnValue), raw: returnValue }
  }

  const selector = returnValue.slice(0, 10).toLowerCase()
  for (const item of abi) {
    if (item.type !== 'error') continue
    const types = item.inputs.map((i) => i.type)
    const itemSelector = toFunctionSelector(`${item.name}(${types.join(',')})`).toLowerCase()
    if (itemSelector === selector) {
      return { name: item.name, args: decodeArgs(types, returnValue), raw: returnValue }
    }
  }
  return { name: null, args: [], raw: returnValue }
}

function decodeArgs(types, returnValue) {
  try {
    return decodeAbiParameters(parseAbiParameters(types.join(', ')), `0x${returnValue.slice(10)}`)
  } catch {
    return []
  }
}

export class RevertError extends Error {
  constructor(functionName, res, abi) {
    const decoded = decodeRevert(res.returnValue, abi)
    const args = decoded.args.length ? `(${decoded.args.join(', ')})` : ''
    super(`${functionName} reverted: ${decoded.name ?? res.error}${args}`)
    this.decoded = decoded
    this.res = res
  }
}
