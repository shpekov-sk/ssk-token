// Читает имя, тикер и decimals из самого контракта и собирает token list.
//
//   node scripts/token-list.mjs 0xАДРЕС
//   TOKEN_ADDRESS=0x... LOGO_URL=https://... node scripts/token-list.mjs
//
// Имя и тикер берутся из сети, а не из переменных: дефолты тут однажды подставили
// «$$K.1» в список другого токена, и это прошло молча.
import * as chains from 'viem/chains'
import { createPublicClient, parseAbi } from 'viem'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addressFrom } from './address.mjs'
import { transportFor } from './rpc.mjs'
import { buildTokenList } from './token-list-build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const {
  TOKEN_ADDRESS,
  CHAIN = 'base',
  RPC_URL,
  // Логотип отдаётся своим доменом, а не raw.githubusercontent: путь на GitHub
  // ломается при переименовании репозитория или переносе в организацию.
  LOGO_URL = 'https://zalupa.world/logo-256.png',
  LIST_NAME,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  TOKEN_DECIMALS,
} = process.env

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const parsed = addressFrom({ argv: process.argv.slice(2), env: TOKEN_ADDRESS })
if (parsed.error) fail(parsed.error)

const chain = chains[CHAIN]
if (!chain) fail(`неизвестная сеть "${CHAIN}"`)

const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

// Переменные окружения — только аварийный обход, если узел недоступен.
let name = TOKEN_NAME
let symbol = TOKEN_SYMBOL
let decimals = TOKEN_DECIMALS ? Number(TOKEN_DECIMALS) : undefined

if (name === undefined || symbol === undefined || decimals === undefined) {
  const client = createPublicClient({ chain, transport: transportFor(chain, RPC_URL) })
  const read = (functionName) => client.readContract({ address: parsed.address, abi: ERC20, functionName })

  try {
    name ??= await read('name')
    symbol ??= await read('symbol')
    decimals ??= Number(await read('decimals'))
  } catch (error) {
    fail(
      `не смог прочитать токен из сети: ${error.shortMessage ?? error.message}\n` +
        `Если узел недоступен, передай явно: TOKEN_NAME=... TOKEN_SYMBOL=... TOKEN_DECIMALS=...`,
    )
  }
}

const { list, warnings, error } = buildTokenList({
  chainId: chain.id,
  address: parsed.address,
  name,
  symbol,
  decimals,
  logoURI: LOGO_URL,
  listName: LIST_NAME,
  timestamp: new Date().toISOString(),
})

if (error) fail(error)
for (const warning of warnings) console.warn(`! ${warning}`)

const outDir = join(root, 'assets')
mkdirSync(outDir, { recursive: true })
const path = join(outDir, 'tokenlist.json')
writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`)

console.log(`assets/tokenlist.json — ${name} (${symbol}) в сети ${chain.name}`)
console.log(`  адрес:  ${parsed.address}`)
console.log(`  логотип: ${LOGO_URL}`)
