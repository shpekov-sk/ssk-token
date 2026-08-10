// Отрисовка печати в SVG. Геометрия приходит из sigil.mjs, здесь только внешний вид.
//
// Цвет берётся из keccak того же вида, на котором считается EIP-55 checksum:
// keccak256(строчный hex без 0x). То есть палитра — это буквально контрольная сумма
// адреса, а заглавные буквы в 0x0cf1...A2a — её же биты. Ошибка в одном символе
// сдвигает одну клетку, но перекрашивает печать целиком: опечатку видно, не читая hex.
import { keccak256, stringToBytes, getAddress } from 'viem'
import { cells, traits, ORDER, NEIGHBOURS, OPPOSITE } from './sigil.mjs'

// Порядок как в sigil.mjs: N, E, S, W — но в экранных координатах (y вниз).
const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/** oklch -> #rrggbb. Нужен, чтобы у всех адресов яркость была одна, а менялся только тон. */
export function oklch(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3

  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]

  const channel = (v) => {
    const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${lin.map(channel).join('')}`
}

/** Палитра из контрольной суммы: тон свободный, светлота и насыщенность фиксированные. */
export function palette(address) {
  const body = String(address).replace(/^0[xX]/, '').toLowerCase()
  const sum = keccak256(stringToBytes(body), 'bytes')

  const hue = (sum[0] / 256) * 360
  // Тон один на всю печать: это оттиск одной краской. Обрывы отличаются не цветом,
  // а светлотой — иначе картинка читается как две несвязанные, а не как один узор.
  const warm = sum[1] & 1 ? 8 : -8

  return {
    hue,
    plate: oklch(0.2, 0.03, hue + warm),
    rim: oklch(0.33, 0.05, hue),
    ink: oklch(0.82, 0.15, hue),
    dim: oklch(0.42, 0.055, hue),
    shadow: oklch(0.13, 0.025, hue),
    lattice: oklch(0.28, 0.03, hue),
  }
}

const SIZE = 512
const CELL = 46
const GRID = 8
const PAD = (SIZE - CELL * GRID) / 2

const xy = (r, c) => [PAD + c * CELL + CELL / 2, PAD + r * CELL + CELL / 2]
const f = (n) => Math.round(n * 100) / 100

/**
 * @param {string} address
 * @param {{label?: boolean, size?: number}} [options] label — подписать адрес под печатью
 * @returns {string} SVG
 */
export function render(address, { label = false, size = SIZE } = {}) {
  const n = cells(address)
  const p = palette(address)
  const checksummed = getAddress(`0x${String(address).replace(/^0[xX]/, '').toLowerCase()}`)

  const width = CELL * 0.34
  const parts = []

  // Решётка: у пустых клеток остаётся точка, иначе не видно, что там вообще есть клетка.
  for (let i = 0; i < 40; i++) {
    if (n[i] !== 0) continue
    const [x, y] = xy(...ORDER[i])
    parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(width * 0.16)}" fill="${p.lattice}"/>`)
  }

  const linked = []
  const stubs = []
  const joints = []

  for (let i = 0; i < 40; i++) {
    const [r, c] = ORDER[i]
    const [x, y] = xy(r, c)
    let live = 0

    for (let d = 0; d < 4; d++) {
      if (!(n[i] & (1 << d))) continue
      const [dx, dy] = DIRS[d]
      const j = NEIGHBOURS[i][d]

      if (j >= 0 && n[j] & (1 << OPPOSITE[d])) {
        // Половина линии до границы клетки: вторая половина придёт от соседа.
        linked.push(`M${f(x)} ${f(y)}L${f(x + (dx * CELL) / 2)} ${f(y + (dy * CELL) / 2)}`)
        live++
      } else {
        const len = CELL * 0.28
        stubs.push(`M${f(x)} ${f(y)}L${f(x + dx * len)} ${f(y + dy * len)}`)
      }
    }

    // Узел там, где сошлись две и больше живых линии: без него на изломе видно стык.
    if (live >= 2) joints.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(width / 2)}"/>`)
  }

  const strokes = `stroke-linecap="round" stroke-linejoin="round" fill="none"`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${size}" height="${size}" role="img" aria-label="печать адреса ${checksummed}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="${f(SIZE * 0.055)}" fill="${p.plate}"/>`,
    `<rect x="6" y="6" width="${SIZE - 12}" height="${SIZE - 12}" rx="${f(SIZE * 0.045)}" fill="none" stroke="${p.rim}" stroke-width="1.5"/>`,
    parts.join(''),
    // Обрывы — тем же тоном, но тусклее: линия, которой не с чем сойтись.
    `<g ${strokes} stroke="${p.dim}" stroke-width="${f(width * 0.68)}"><path d="${stubs.join('')}"/></g>`,
    `<g ${strokes} stroke="${p.ink}" stroke-width="${f(width)}"><path d="${linked.join('')}"/></g>`,
    `<g fill="${p.ink}">${joints.join('')}</g>`,
    label
      ? `<text x="${SIZE / 2}" y="${SIZE - 26}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="15" letter-spacing="0.5" fill="${p.rim}">${checksummed}</text>`
      : '',
    `</svg>`,
  ].join('\n')
}

export { traits }
