// Печать адреса: 40 hex-символов -> 40 клеток восьмиугольника, ровно по одной на символ.
//
// Это не хеш-иконка: отображение биективное, из картинки адрес читается обратно
// (addressFromCells). Каждый символ — это 4 бита, а 4 бита клетки — это четыре её
// выхода: север, восток, юг, запад. Линия между соседними клетками появляется там,
// где встречные выходы совпали. Отсюда и «красота»: у случайного адреса три четверти
// линий обрываются, у выбранного — складываются в узор.
//
// Цвет (серия) берётся из keccak адреса — того же хеша, что даёт EIP-55 checksum.
// Опечатка в одном символе меняет одну клетку, но перекрашивает печать целиком.

const GRID = 8
const REACH = 4 // клетка существует, если |r-3.5| + |c-3.5| <= REACH

/** Ромб на квадратной решётке: ровно 40 клеток, замкнут на поворот 90°. */
export function isCell(r, c) {
  return Math.abs(r - 3.5) + Math.abs(c - 3.5) <= REACH
}

/** Клетки в порядке чтения адреса: слева направо, сверху вниз. */
export const ORDER = []
for (let r = 0; r < GRID; r++) {
  for (let c = 0; c < GRID; c++) if (isCell(r, c)) ORDER.push([r, c])
}

const INDEX = new Map(ORDER.map(([r, c], i) => [r * GRID + c, i]))

// Выходы клетки = биты нибла. N=1, E=2, S=4, W=8.
const DIRS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
]
const OPPOSITE = [2, 3, 0, 1]

/** Индекс соседа через выход d, либо -1, если там край восьмиугольника. */
function neighbour(i, d) {
  const [r, c] = ORDER[i]
  const [dr, dc] = DIRS[d]
  const nr = r + dr
  const nc = c + dc
  // Без этой проверки колонка -1 свернулась бы в последнюю клетку предыдущей строки.
  if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) return -1
  return INDEX.get(nr * GRID + nc) ?? -1
}

const NEIGHBOURS = ORDER.map((_, i) => DIRS.map((_, d) => neighbour(i, d)))

export { NEIGHBOURS, OPPOSITE }

const HEX_40 = /^[0-9a-fA-F]{40}$/

/**
 * Адрес в 40 ниблов. Регистр и префикс 0x не важны — картинка от них не зависит.
 * @returns {Uint8Array}
 */
export function cells(address) {
  const raw = String(address ?? '').trim()
  const body = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
  if (!HEX_40.test(body)) {
    throw new Error(`это не адрес: нужно 40 hex-символов, пришло ${body.length}`)
  }
  const out = new Uint8Array(40)
  for (let i = 0; i < 40; i++) out[i] = parseInt(body[i], 16)
  return out
}

/** Обратное преобразование: печать -> адрес. Тем и отличается от хеш-иконки. */
export function addressFromCells(nibbles) {
  if (nibbles.length !== 40) throw new Error(`нужно 40 клеток, пришло ${nibbles.length}`)
  let hex = ''
  for (const n of nibbles) {
    if (!(n >= 0 && n <= 15)) throw new Error(`клетка вне 0..15: ${n}`)
    hex += n.toString(16)
  }
  return `0x${hex}`
}

// Поворот на 90° по часовой: клетка (r,c) -> (c, 7-r), а выходы сдвигаются N->E->S->W.
const ROT_CELL = ORDER.map(([r, c]) => INDEX.get(c * GRID + (GRID - 1 - r)))
const rotPorts = (v) => ((v << 1) | (v >> 3)) & 15
// Зеркало по вертикальной оси: меняются местами E и W.
const MIRROR_CELL = ORDER.map(([r, c]) => INDEX.get(r * GRID + (GRID - 1 - c)))
const flipPorts = (v) => (v & 0b0101) | ((v & 0b0010) << 2) | ((v & 0b1000) >> 2)

/**
 * Эталон: единственная раскладка, где сшито всё, что можно, и ничего не торчит.
 * Выход клетки включён тогда и только тогда, когда за ним есть клетка.
 * Такой адрес существует ровно один, и найти его нельзя — 2^-160.
 */
export const PERFECT = addressFromCells(
  NEIGHBOURS.map((ns) => ns.reduce((v, n, d) => (n >= 0 ? v | (1 << d) : v), 0)),
)

/**
 * Что можно сказать про печать, не глядя на неё.
 * links  — внутренние стыки, где обе половины линии на месте (максимум 64)
 * stubs  — выходы, которым некуда идти: обрывы линий
 * score  — links - stubs: чем больше линий и меньше обрывов, тем выше
 */
export function traits(address) {
  return traitsOf(cells(address))
}

/** То же, но по готовым ниблам — перебор адресов идёт через эту дверь. */
export function traitsOf(n) {
  let links = 0
  let stubs = 0
  for (let i = 0; i < 40; i++) {
    for (let d = 0; d < 4; d++) {
      if (!(n[i] & (1 << d))) continue
      const j = NEIGHBOURS[i][d]
      if (j >= 0 && n[j] & (1 << OPPOSITE[d])) {
        if (j > i) links++ // стык считаем один раз
      } else {
        stubs++
      }
    }
  }

  let rotation = 0
  let mirror = 0
  for (let i = 0; i < 40; i++) {
    if (n[ROT_CELL[i]] === rotPorts(n[i])) rotation++
    if (n[MIRROR_CELL[i]] === flipPorts(n[i])) mirror++
  }

  let run = 1
  let longestRun = 1
  for (let i = 1; i < 40; i++) {
    run = n[i] === n[i - 1] ? run + 1 : 1
    if (run > longestRun) longestRun = run
  }

  let leadingZeros = 0
  while (leadingZeros < 40 && n[leadingZeros] === 0) leadingZeros++

  const ink = n.reduce((sum, v) => sum + popcount(v), 0) // сколько выходов занято из 160

  return {
    links,
    stubs,
    score: links - stubs,
    integrity: links + stubs === 0 ? 0 : links / (links + stubs),
    rotation,
    mirror,
    longestRun,
    leadingZeros,
    distinct: new Set(n).size,
    ink,
    cycles: cyclesOf(n),
    bar: barOf(n),
  }
}

const popcount = (v) => (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1)

/**
 * Сколько в узоре независимых замкнутых контуров: E - V + C по сшитым линиям.
 * Кольцо глаз видит сразу, в отличие от счёта стыков, поэтому это главный признак
 * «дорогой» печати. Считается через объединение множеств, а не обходом по степени 2:
 * у плотной сетки выходов четыре, и обход по степени 2 не нашёл бы там ни одного кольца.
 */
function cyclesOf(n) {
  const parent = new Int8Array(40).fill(-1)
  const find = (x) => {
    while (parent[x] >= 0) x = parent[x]
    return x
  }

  let edges = 0
  const touched = new Uint8Array(40)
  let components = 0

  for (let i = 0; i < 40; i++) {
    for (let d = 0; d < 4; d++) {
      if (!(n[i] & (1 << d))) continue
      const j = NEIGHBOURS[i][d]
      if (j < 0 || !(n[j] & (1 << OPPOSITE[d]))) continue
      if (j < i) continue // ребро считаем один раз

      edges++
      touched[i] = 1
      touched[j] = 1
      const a = find(i)
      const b = find(j)
      if (a !== b) parent[a] = b
    }
  }

  let vertices = 0
  for (let i = 0; i < 40; i++) {
    if (!touched[i]) continue
    vertices++
    if (find(i) === i) components++
  }

  return edges - vertices + components
}

/** Длиннейшая сплошная линия, в клетках. 0, если сшивать нечего. */
function barOf(n) {
  let best = 0
  // Восток и юг: каждая линия найдётся от своего левого/верхнего конца.
  for (const d of [1, 2]) {
    for (let i = 0; i < 40; i++) {
      let len = 1
      let cell = i
      for (;;) {
        if (!(n[cell] & (1 << d))) break
        const j = NEIGHBOURS[cell][d]
        if (j < 0 || !(n[j] & (1 << OPPOSITE[d]))) break
        len++
        cell = j
      }
      if (len > 1 && len > best) best = len // одинокая клетка — ещё не линия
    }
  }
  return best
}
