// Разбор адреса из аргумента или окружения, с внятным объяснением отказа.
//
// EIP-55 кодирует контрольную сумму регистром букв, и viem проверяет её строго.
// Поэтому одна перепутанная буква даёт «адрес невалиден» — технически верно,
// практически бесполезно. Здесь такие случаи разделены: не задан, не похож на
// адрес, не сходится контрольная сумма (и тогда показывается правильный вид).
import { getAddress, isAddress } from 'viem'

const HEX_40 = /^0x[0-9a-fA-F]{40}$/

/**
 * @param {string|undefined} value что пришло от пользователя
 * @param {string} label как называется параметр в сообщениях
 * @returns {{address: string, warning?: string}} либо {error}
 */
export function parseAddress(value, label = 'TOKEN_ADDRESS') {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { error: `нужен адрес: ${label}=0x... или первым аргументом` }
  }

  const raw = String(value).trim()

  if (!raw.startsWith('0x')) {
    return { error: `адрес должен начинаться с 0x, получено "${raw}"` }
  }
  if (!HEX_40.test(raw)) {
    const length = raw.length - 2
    return {
      error:
        `это не похоже на адрес: ${length} символов после 0x вместо 40` +
        (/[^0-9a-fA-Fx]/.test(raw) ? ', и есть символы вне hex' : ''),
    }
  }

  const body = raw.slice(2)
  const hasLower = /[a-f]/.test(body)
  const hasUpper = /[A-F]/.test(body)

  // В одном регистре контрольной суммы нет — проверять нечего, приводим к EIP-55.
  if (!hasLower || !hasUpper) return { address: getAddress(raw.toLowerCase()) }

  if (isAddress(raw)) return { address: getAddress(raw) }

  // Смешанный регистр, но сумма не сходится: почти всегда опечатка при копировании.
  return {
    error:
      `контрольная сумма адреса не сходится — в EIP-55 её кодирует регистр букв,\n` +
      `так что где-то перепутана одна буква.\n` +
      `  дано:       ${raw}\n` +
      `  правильно:  ${getAddress(raw.toLowerCase())}`,
  }
}

/**
 * Адрес из первого позиционного аргумента или из переменной окружения.
 * Аргумент сильнее: его набирают осознанно.
 */
export function addressFrom({ argv = [], env, label = 'TOKEN_ADDRESS' } = {}) {
  const positional = argv.find((arg) => !arg.startsWith('-'))
  return parseAddress(positional ?? env, label)
}
