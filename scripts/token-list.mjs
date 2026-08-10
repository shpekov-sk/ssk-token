// Генератор token list формата Uniswap. Кошельки и агрегаторы берут отсюда
// логотип, имя и decimals — в самом ERC-20 полей под это нет.
//
//   TOKEN_ADDRESS=0x... CHAIN=base LOGO_URL=https://... node scripts/token-list.mjs
import { getAddress, isAddress } from 'viem'
import * as chains from 'viem/chains'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const {
  TOKEN_ADDRESS,
  CHAIN = 'base',
  TOKEN_NAME = '$$K.1',
  TOKEN_SYMBOL = '$$K.1',
  TOKEN_DECIMALS = '18',
  LIST_NAME = '$$K.1 List',
  LOGO_URL,
} = process.env

if (!TOKEN_ADDRESS || !isAddress(TOKEN_ADDRESS)) {
  console.error('нужен TOKEN_ADDRESS=0x... — адрес контракта после деплоя')
  process.exit(1)
}

const chain = chains[CHAIN]
if (!chain) {
  console.error(`неизвестная сеть "${CHAIN}"`)
  process.exit(1)
}

// Схема Uniswap ограничивает symbol 20 символами и запрещает пробелы;
// "$" и "." проходят, но проверить дешевле, чем ловить отказ при подаче списка.
const SYMBOL_RE = /^[a-zA-Z0-9+\-%/$._]+$/
if (!SYMBOL_RE.test(TOKEN_SYMBOL) || TOKEN_SYMBOL.length > 20) {
  console.error(`символ "${TOKEN_SYMBOL}" не пройдёт валидацию token list`)
  process.exit(1)
}

const list = {
  name: LIST_NAME,
  timestamp: new Date().toISOString(),
  version: { major: 1, minor: 0, patch: 0 },
  logoURI: LOGO_URL,
  keywords: ['personal', 'fun'],
  tokens: [
    {
      chainId: chain.id,
      address: getAddress(TOKEN_ADDRESS), // checksummed — иначе список не примут
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      decimals: Number(TOKEN_DECIMALS),
      ...(LOGO_URL ? { logoURI: LOGO_URL } : {}),
    },
  ],
}

mkdirSync(join(root, 'assets'), { recursive: true })
const path = join(root, 'assets', 'tokenlist.json')
writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`)

console.log(`assets/tokenlist.json — ${TOKEN_SYMBOL} в сети ${chain.name}`)
if (!LOGO_URL) {
  console.log('\nlogoURI не задан. Залей assets/logo-256.png куда-нибудь с постоянным URL')
  console.log('(например, в публичный репозиторий на GitHub -> raw-ссылка) и перегенерируй с LOGO_URL=...')
}
