// Сборка token list формата Uniswap.
//
// В ERC-20 нет полей под логотип и описание, поэтому кошельки и агрегаторы
// берут их отсюда. Схема списка строгая: тикер только из ограниченного набора
// символов, адрес обязательно в EIP-55, chainId числом.
import { getAddress } from 'viem'

// Тот же набор, что в схеме Uniswap: https://uniswap.org/tokenlist.schema.json
const SYMBOL_PATTERN = /^[a-zA-Z0-9+\-%/$._]+$/

/**
 * @returns {{list: object, warnings: string[]}} либо {error}
 */
export function buildTokenList({
  chainId,
  address,
  name,
  symbol,
  decimals,
  logoURI,
  listName,
  keywords = ['personal', 'fun'],
  timestamp,
  version = { major: 1, minor: 0, patch: 0 },
}) {
  const warnings = []

  if (!Number.isInteger(chainId) || chainId <= 0) return { error: `chainId должен быть целым числом, дано ${chainId}` }
  if (!name) return { error: 'нет имени токена' }
  if (!symbol) return { error: 'нет тикера' }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return { error: `decimals вне допустимого диапазона: ${decimals}` }
  }

  let checksummed
  try {
    checksummed = getAddress(address)
  } catch {
    return { error: `адрес не проходит проверку: ${address}` }
  }

  if (!SYMBOL_PATTERN.test(symbol)) {
    warnings.push(`тикер "${symbol}" не соответствует схеме Uniswap — список могут не принять`)
  }
  if (symbol.length > 20) warnings.push(`тикер длиннее 20 символов — схема требует до 20`)
  if (name.length > 40) warnings.push(`имя длиннее 40 символов — схема требует до 40`)
  if (!logoURI) warnings.push('без logoURI кошельки покажут серый кружок')
  else if (!/^https:\/\//.test(logoURI)) warnings.push('logoURI лучше отдавать по https, иначе часть клиентов его не загрузит')

  const token = { chainId, address: checksummed, name, symbol, decimals }
  if (logoURI) token.logoURI = logoURI

  return {
    warnings,
    list: {
      name: listName ?? `${symbol} List`,
      timestamp: timestamp ?? '1970-01-01T00:00:00.000Z',
      version,
      ...(logoURI ? { logoURI } : {}),
      keywords,
      tokens: [token],
    },
  }
}
