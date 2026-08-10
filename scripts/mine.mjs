// Подбор адреса с красивой печатью. Ключи перебираются локально, ничего не уходит в сеть.
//
//   node scripts/mine.mjs --score 5 --minutes 2
//   node scripts/mine.mjs --cycles 2 --minutes 5
//   node scripts/mine.mjs --prefix beef --show
//
// Как это работает: берётся случайный ключ k, дальше вместо повторного умножения
// считается k+1, k+2, ... — а это на кривой просто прибавление точки G к предыдущей.
// Одно сложение вместо полного умножения даёт ~17k адресов в секунду против ~3.7k.
//
// Что важно понимать про безопасность: старт случайный (32 байта из CSPRNG), поэтому
// сам ключ остаётся непредсказуемым. Но соседние найденные ключи связаны между собой
// (k, k+1, ...), так что использовать из одного прогона нужно один адрес, а не пачку.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { randomBytes } from 'node:crypto'
import { traitsOf } from './sigil.mjs'

const N = secp256k1.CURVE.n

/** Точка кривой -> 20 байт адреса. keccak от 64 байт несжатой координаты, последние 20. */
function addressBytes(point, scratch) {
  const { x, y } = point.toAffine()
  writeBE32(scratch, 0, x)
  writeBE32(scratch, 32, y)
  return keccak_256(scratch).subarray(12)
}

function writeBE32(out, offset, value) {
  for (let i = 31; i >= 0; i--) {
    out[offset + i] = Number(value & 0xffn)
    value >>= 8n
  }
}

const HEX = '0123456789abcdef'

/** 20 байт -> 40 ниблов, без промежуточной строки: это самый горячий участок. */
function toNibbles(bytes, out) {
  for (let i = 0; i < 20; i++) {
    out[i * 2] = bytes[i] >> 4
    out[i * 2 + 1] = bytes[i] & 15
  }
  return out
}

function toHex(bytes) {
  let s = ''
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 15]
  return s
}

/**
 * Ищет адрес, проходящий accept(). Возвращает {privateKey, address, attempts} или null.
 * @param {(nibbles: Uint8Array, hex: string) => boolean} accept
 * @param {{deadline?: number, onProgress?: (n: number) => void}} [options]
 */
export function mine(accept, { deadline = Infinity, onProgress } = {}) {
  const start = (BigInt(`0x${randomBytes(32).toString('hex')}`) % (N - 2n)) + 1n
  const G = secp256k1.ProjectivePoint.BASE

  let point = G.multiply(start)
  let key = start

  const scratch = new Uint8Array(64)
  const nibbles = new Uint8Array(40)
  let attempts = 0

  for (;;) {
    const bytes = addressBytes(point, scratch)
    const hex = toHex(bytes)
    attempts++

    if (accept(toNibbles(bytes, nibbles), hex)) {
      return { privateKey: `0x${key.toString(16).padStart(64, '0')}`, address: `0x${hex}`, attempts }
    }

    // Время и прогресс проверяем редко: Date.now() дороже самой итерации.
    if ((attempts & 8191) === 0) {
      onProgress?.(attempts)
      if (Date.now() > deadline) return null
    }

    point = point.add(G)
    key += 1n
    if (key >= N) return null // до края кривой не дойти, но пусть будет явно
  }
}

/** Условия отбора. Комбинируются: адрес должен пройти все заданные. */
export function makeFilter({ minScore, prefix, suffix, minRotation, minMirror, minCycles, minBar }) {
  const pre = prefix?.toLowerCase()
  const suf = suffix?.toLowerCase()
  const wantsTraits =
    minScore != null || minRotation != null || minMirror != null || minCycles != null || minBar != null

  return (nibbles, hex) => {
    // Префикс отсекает 15/16 кандидатов на сравнении строк, до счёта признаков.
    if (pre && !hex.startsWith(pre)) return false
    if (suf && !hex.endsWith(suf)) return false
    if (!wantsTraits) return true

    const t = traitsOf(nibbles)
    if (minScore != null && t.score < minScore) return false
    if (minRotation != null && t.rotation < minRotation) return false
    if (minMirror != null && t.mirror < minMirror) return false
    if (minCycles != null && t.cycles < minCycles) return false
    if (minBar != null && t.bar < minBar) return false
    return true
  }
}

// Ниже — запуск из командной строки. При импорте модуля не выполняется.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { render } = await import('./render.mjs')
  const { getAddress } = await import('viem')

  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i < 0 ? fallback : (argv[i + 1] ?? true)
  }

  const minutes = Number(flag('minutes', 2))
  const num = (name) => (flag(name) == null ? undefined : Number(flag(name)))
  const filter = makeFilter({
    minScore: num('score'),
    minRotation: num('rotation'),
    minMirror: num('mirror'),
    minCycles: num('cycles'),
    minBar: num('bar'),
    prefix: flag('prefix'),
    suffix: flag('suffix'),
  })

  const deadline = Date.now() + minutes * 60_000
  const started = Date.now()
  process.stdout.write('ищу... ')

  // Прогресс обновляется по месту (одна строка, \r), а не спамит лог на каждой итерации.
  let last = Date.now()
  const found = mine(filter, {
    deadline,
    onProgress: (n) => {
      const now = Date.now()
      if (now - last < 200) return
      last = now
      const rate = Math.round(n / ((now - started) / 1000) / 1000)
      process.stdout.write(`\rищу... ${(n / 1e6).toFixed(2)}M адресов, ${rate}k/сек   `)
    },
  })

  process.stdout.write('\r'.padEnd(70) + '\r')

  if (!found) {
    console.log(`за ${minutes} мин не нашлось. Ослабь условие или дай больше времени.`)
    process.exit(1)
  }

  const address = getAddress(found.address)
  const t = traitsOf(new Uint8Array([...found.address.slice(2)].map((c) => parseInt(c, 16))))

  mkdirSync('marks', { recursive: true })
  const svg = `marks/${found.address.slice(2, 10)}.svg`
  writeFileSync(svg, render(address, { label: true }))

  console.log(`адрес:    ${address}`)
  console.log(`печать:   ${svg}`)
  console.log(`счёт:     ${t.score}  (сшито ${t.links} из 64, обрывов ${t.stubs})`)
  console.log(`симметрия: поворот ${t.rotation}/40, зеркало ${t.mirror}/40`)
  console.log(`узор:     колец ${t.cycles}, длиннейшая линия ${t.bar}`)
  console.log(`перебрано: ${found.attempts.toLocaleString('ru')} адресов`)

  if (flag('show')) {
    console.log(`\nприватный ключ: ${found.privateKey}`)
    console.log('он больше нигде не сохранён — это единственная копия')
  } else {
    const file = `marks/${found.address.slice(2, 10)}.key`
    writeFileSync(file, `${found.privateKey}\n`, { mode: 0o600 })
    console.log(`ключ:     ${file} (права 600)`)
  }

  console.log('\nЭто новый пустой кошелёк. Ключ хранится только у тебя, никуда не отправлялся.')
}

