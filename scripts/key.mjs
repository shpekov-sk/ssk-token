// Приведение приватного ключа к виду, который ждёт viem, с внятной диагностикой.
// Сам ключ никуда не печатается, не логируется и не сохраняется.

const HEX_64 = /^[0-9a-fA-F]{64}$/

/**
 * @returns {{key: `0x${string}`}} при успехе, либо {error} с объяснением.
 */
export function normalizePrivateKey(raw) {
  if (raw == null || raw === '') return { error: 'переменная PRIVATE_KEY пустая' }

  // Кавычки и переводы строк регулярно приезжают вместе с копипастой.
  const cleaned = String(raw).trim().replace(/^['"]|['"]$/g, '').trim()

  if (cleaned === '') return { error: 'в PRIVATE_KEY одни пробелы' }
  if (cleaned.includes('...') || cleaned === '0x') {
    return { error: 'вместо ключа подставлен placeholder из примера (0x...)' }
  }

  const words = cleaned.split(/\s+/)
  if (words.length >= 12) {
    return {
      error:
        `это seed-фраза из ${words.length} слов, а не приватный ключ. ` +
        'Ключ — одна строка из 64 символов 0-9 и a-f',
    }
  }
  if (words.length > 1) return { error: 'в ключе есть пробелы — скопировалось что-то лишнее' }

  const body = cleaned.startsWith('0x') || cleaned.startsWith('0X') ? cleaned.slice(2) : cleaned

  if (!HEX_64.test(body)) {
    if (body.length !== 64) {
      return {
        error:
          `длина ${body.length} символов вместо 64. ` +
          (body.length > 64 ? 'Скопировалось лишнее' : 'Строка обрезана при копировании'),
      }
    }
    const bad = [...new Set(body.replace(/[0-9a-fA-F]/g, ''))].join(' ')
    return { error: `длина верная, но есть символы не из hex: ${bad}` }
  }

  // MetaMask показывает ключ без префикса — дописываем сами, это не ошибка.
  return { key: `0x${body.toLowerCase()}` }
}
