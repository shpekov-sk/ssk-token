// Проверка третьего допущения: «никакого хардкода, картинку рисует чистая математика».
// Две колонки на одной и той же 512-битной ДНК:
//   слева  — честный шум (fBm + пороги), как в концепте
//   справа — тот же шум, но по сетке лица: глаза, рот, контур головы заданы кодом
// Это и есть хардкод — просто записанный формулой, а не PNG-слоями.
import { keccak_256 } from '@noble/hashes/sha3.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const S = 64

/** Поток псевдослучайных чисел из 512 бит ДНК: keccak в режиме счётчика. */
function stream(dna) {
  let buf = new Uint8Array(0)
  let i = 0
  let ctr = 0
  return () => {
    if (i >= buf.length) {
      const input = new Uint8Array(dna.length + 4)
      input.set(dna)
      new DataView(input.buffer).setUint32(dna.length, ctr++)
      buf = keccak_256(input)
      i = 0
    }
    return buf[i++] / 255
  }
}

/** Гладкий шум значений с бикубическим сглаживанием — база для fBm. */
function valueNoise(rand, cells) {
  const g = []
  for (let y = 0; y <= cells; y++) {
    g.push(Array.from({ length: cells + 1 }, () => rand()))
  }
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = x * cells
    const fy = y * cells
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = smooth(fx - x0)
    const ty = smooth(fy - y0)
    const a = g[y0][x0] * (1 - tx) + g[y0][x0 + 1] * tx
    const b = g[y0 + 1][x0] * (1 - tx) + g[y0 + 1][x0 + 1] * tx
    return a * (1 - ty) + b * ty
  }
}

function fbm(rand) {
  const octaves = [valueNoise(rand, 4), valueNoise(rand, 8), valueNoise(rand, 16)]
  return (x, y) => octaves[0](x, y) * 0.6 + octaves[1](x, y) * 0.3 + octaves[2](x, y) * 0.1
}

/** Вариант А: чистый шум, никакой структуры. Ровно то, что описано в концепте. */
function pureNoise(dna) {
  const rand = stream(dna)
  const n = fbm(rand)
  const px = []
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      px.push(n(x / S, y / S) > 0.5 ? 1 : 0)
    }
  }
  return px
}

/** Вариант Б: шум натянут на заданную кодом схему лица. */
function structured(dna) {
  const rand = stream(dna)
  const n = fbm(rand)

  // Ниже — тот самый «хардкод»: пропорции головы и позиции черт заданы человеком.
  const headW = 0.32 + rand() * 0.1
  const headH = 0.38 + rand() * 0.08
  const eyeY = 0.42 + rand() * 0.06
  const eyeX = 0.17 + rand() * 0.06
  const eyeR = 0.05 + rand() * 0.03
  const mouthY = 0.66 + rand() * 0.07
  const mouthW = 0.14 + rand() * 0.1
  const px = []

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S - 0.5
      const v = y / S - 0.5
      const wobble = (n(x / S, y / S) - 0.5) * 0.09 // шум только мнёт контур
      const head = Math.hypot(u / headW, (v + 0.02) / headH) + wobble

      let val = 0
      if (head < 1) val = 1
      // Глаза и рот вычитаются из головы — их место известно заранее.
      if (Math.hypot(Math.abs(u) - eyeX, v - (eyeY - 0.5)) < eyeR) val = 2
      if (Math.abs(u) < mouthW && Math.abs(v - (mouthY - 0.5)) < 0.022) val = 2
      px.push(val)
    }
  }
  return px
}

/** Плитка 64×64: соседние пиксели строки сливаются в один rect. */
function tile(px, hue, ox, oy, cell) {
  const fill = [null, `hsl(${hue} 55% 58%)`, `hsl(${hue} 60% 12%)`]
  let out = `<rect x="${ox}" y="${oy}" width="${S * cell}" height="${S * cell}" fill="hsl(${hue} 25% 9%)"/>`
  for (let y = 0; y < S; y++) {
    let x = 0
    while (x < S) {
      const c = px[y * S + x]
      let w = 1
      while (x + w < S && px[y * S + x + w] === c) w++
      // Без склейки серий выходило по 4096 прямоугольников на плитку и мегабайты файла.
      if (c) {
        out += `<rect x="${ox + x * cell}" y="${oy + y * cell}" width="${w * cell}" height="${cell}" fill="${fill[c]}"/>`
      }
      x += w
    }
  }
  return out
}

mkdirSync('marks', { recursive: true })

const CELL = 3
const TILE = S * CELL
const GAP = 18
const HEAD = 46
const ROWS = 4
const W = GAP + (TILE + GAP) * 2
const H = HEAD + (TILE + GAP) * ROWS

const text = (x, y, t, fill, size = 12, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="ui-monospace,Menlo,monospace" font-size="${size}" text-anchor="${anchor}">${t}</text>`

let body = `<rect width="${W}" height="${H}" fill="#111"/>`
body += text(GAP, 22, 'чистый шум', '#bbb')
body += text(GAP, 37, '«никакого хардкода»', '#555', 11)
body += text(GAP + TILE + GAP, 22, 'шум по схеме лица', '#bbb')
body += text(GAP + TILE + GAP, 37, 'черты заданы кодом', '#555', 11)

for (let i = 0; i < ROWS; i++) {
  const dna = randomBytes(64) // 512 бит: адрес + TxID
  const hue = Math.round((dna[0] / 256) * 360)
  const y = HEAD + i * (TILE + GAP)
  body += tile(pureNoise(dna), hue, GAP, y, CELL)
  body += tile(structured(dna), hue, GAP + TILE + GAP, y, CELL)
}

const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">${body}</svg>`
writeFileSync('marks/faces.svg', out)
console.log(`marks/faces.svg — ${(out.length / 1024).toFixed(0)} КБ`)
