// Ловля опечаток в именах переменных окружения.
//
// Молча проигнорированная переменная — худший вид ошибки: скрипт берёт дефолт
// и делает не то, о чём просили, а сообщение об ошибке говорит про дефолт.
// Поэтому все наши имена перечислены явно, а похожее-но-не-то вызывает отказ.

/** Переменные, которые вообще что-то значат в скриптах проекта. */
export const KNOWN = new Set([
  'PRIVATE_KEY',
  'RPC_URL',
  'CHAIN',
  'CONFIRM',
  'HOLDER',
  'ROUTER',
  'TOKEN_ADDRESS',
  'TOKEN_NAME',
  'TOKEN_SYMBOL',
  'TOKEN_DECIMALS',
  'TOKEN_SUPPLY',
  'POOL_TOKENS',
  'TARGET_PRICE_USD',
  'ETH_USD',
  'SLIPPAGE_BPS',
  'ETHERSCAN_API_KEY',
  'LOGO_URL',
])

/** Синонимы, которые логично перепутать. Принимаются, но с оговоркой. */
export const ALIASES = {
  TARGET_PRICE: 'TARGET_PRICE_USD',
  PRICE_USD: 'TARGET_PRICE_USD',
  TOKEN: 'TOKEN_ADDRESS',
  ADDRESS: 'TOKEN_ADDRESS',
  API_KEY: 'ETHERSCAN_API_KEY',
  SUPPLY: 'TOKEN_SUPPLY',
  NAME: 'TOKEN_NAME',
  SYMBOL: 'TOKEN_SYMBOL',
}

// Смотрим только на «наши» префиксы, чтобы не разбирать весь process.env.
const PREFIXES = ['TOKEN', 'POOL', 'TARGET', 'ETH', 'RPC', 'SLIPPAGE', 'PRICE', 'CONFIRM', 'HOLDER', 'ROUTER', 'CHAIN']

const looksLikeOurs = (name) => PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`))

/**
 * Разбирает окружение: подставляет синонимы и находит непонятные имена.
 * @returns {{values: object, aliased: Array, unknown: string[]}}
 */
export function resolveEnv(env) {
  const values = {}
  const aliased = []
  const unknown = []

  for (const [name, value] of Object.entries(env)) {
    if (KNOWN.has(name)) {
      values[name] = value
      continue
    }

    const alias = ALIASES[name]
    if (alias) {
      // Явное имя всегда сильнее синонима.
      if (env[alias] === undefined) values[alias] = value
      aliased.push({ from: name, to: alias, used: env[alias] === undefined })
      continue
    }

    if (looksLikeOurs(name)) unknown.push(name)
  }

  return { values, aliased, unknown }
}

/** Печатает предупреждения и возвращает значения. fail вызывается на непонятных именах. */
export function readEnv(env, fail) {
  const { values, aliased, unknown } = resolveEnv(env)

  for (const { from, to, used } of aliased) {
    console.warn(used ? `${from} принят как ${to}` : `${from} проигнорирован: задан ${to}`)
  }

  if (unknown.length) {
    fail(
      `непонятные переменные: ${unknown.join(', ')}\n` +
        `Проверь имя — молча проигнорировать их хуже, чем отказаться.\n` +
        `Известные: ${[...KNOWN].join(', ')}`,
    )
  }

  return values
}
