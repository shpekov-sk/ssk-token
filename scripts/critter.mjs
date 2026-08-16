// Существо из адреса: 64×64, признаки читаются прямо из 160 бит адреса.
//
// Почему не «случайные пиксели»: картинок 64×64 даже в двух цветах 2^4096. Перебор
// не доберётся до узнаваемого лица никогда — в этом пространстве почти всё шум.
// Поэтому случайность заходит не в пиксели, а в признаки: 81 бит выбирает, кто это,
// какие глаза, рот и что на голове. Тогда любой адрес даёт существо, а перебор ищет
// не «картинку», а редкое сочетание — как блатной номер.
//
// Отрисовка симметричная: считается левая половина, правая зеркалится. Двусторонняя
// симметрия и толстый контур — то, из-за чего 64×64 вообще читается как лицо.

import { oklch } from './render.mjs'

const S = 64
const HALF = S / 2

// Индексы палитры. 0 — пусто, дальше слои от кожи к акцентам.
const BG = 1
const SKIN = 2
const SHADE = 3
const LINE = 4
const SCLERA = 5
const PUPIL = 6
const ACC = 7
const ACC2 = 8

/**
 * Таблица с весами: n бит адреса -> значение. Повторы задают частоту,
 * и из них же берётся вероятность — редкость потом считается по ней, а не на глаз.
 */
function table(bits, weights) {
  const size = 1 << bits
  const total = weights.reduce((s, [w]) => s + w, 0)
  if (total !== size) throw new Error(`веса дают ${total}, а ${bits} бит вмещают ${size}`)
  const lut = []
  for (const [w, v] of weights) for (let i = 0; i < w; i++) lut.push(v)
  return { bits, lut, prob: new Map(weights.map(([w, v]) => [v, w / size])) }
}

const SPECIES = table(6, [
  [26, 'чел'],
  [12, 'кот'],
  [10, 'жаба'],
  [8, 'робот'],
  [5, 'череп'],
  [3, 'демон'],
])

const EYES = table(4, [
  [5, 'круглые'],
  [4, 'овальные'],
  [3, 'щёлки'],
  [2, 'квадратные'],
  [1, 'полуприкрытые'],
  [1, 'крестики'],
])

const MOUTH = table(5, [
  [9, 'линия'],
  [7, 'улыбка'],
  [6, 'хмурый'],
  [5, 'открытый'],
  [4, 'зубы'],
  [1, 'ухмылка'],
])

const HAT = table(6, [
  [30, 'нет'],
  [14, 'кепка'],
  [8, 'капюшон'],
  [6, 'рожки'],
  [4, 'корона'],
  [2, 'нимб'],
])

const WEAR = table(5, [
  [20, 'нет'],
  [6, 'очки'],
  [4, 'тёмные'],
  [2, 'монокль'],
])

export const TABLES = { SPECIES, EYES, MOUTH, HAT, WEAR }

/** Читалка битов адреса слева направо. Каждый признак съедает свою порцию. */
function reader(address) {
  const body = String(address).replace(/^0[xX]/, '')
  if (!/^[0-9a-fA-F]{40}$/.test(body)) throw new Error('нужен адрес: 40 hex-символов')
  let bits = ''
  for (const ch of body) bits += parseInt(ch, 16).toString(2).padStart(4, '0')

  let at = 0
  const take = (n) => {
    const chunk = bits.slice(at, at + n)
    at += n
    return parseInt(chunk, 2)
  }
  return {
    take,
    pick: (t) => t.lut[take(t.bits)],
    spent: () => at,
  }
}

/** Признаки существа: что нарисовано и с какой вероятностью такое выпадает. */
export function features(address) {
  const r = reader(address)

  const species = r.pick(SPECIES)
  const eyes = r.pick(EYES)
  const mouth = r.pick(MOUTH)
  const hat = r.pick(HAT)
  const wear = r.pick(WEAR)

  // Геометрия: мелкий разброс, чтобы одинаковые наборы признаков всё равно отличались.
  // Голова умышленно небольшая: на 64×64 читается силуэт с полями, а не залитый кадр.
  const geom = {
    headW: 12 + r.take(2), // 12..15 полуширина
    headH: 13 + r.take(2), // 13..16 полувысота
    eyeY: 30 + r.take(2), // 30..33
    eyeDX: 6 + r.take(2), // 6..9 от центра
    eyeR: 2 + r.take(1),
    mouthY: 41 + r.take(2),
    mouthW: 4 + r.take(2),
  }

  const hue = (r.take(8) / 256) * 360
  const accentHue = (hue + 120 + r.take(5) * 4) % 360
  const dark = r.take(1) === 1

  const rarity =
    SPECIES.prob.get(species) * EYES.prob.get(eyes) * MOUTH.prob.get(mouth) * HAT.prob.get(hat) * WEAR.prob.get(wear)

  return { species, eyes, mouth, hat, wear, geom, hue, accentHue, dark, rarity, bitsUsed: r.spent() }
}

// ── отрисовка ───────────────────────────────────────────────────────────────
// Всё пишется в левую половину и в конце зеркалится: двусторонняя симметрия —
// половина того, из-за чего 64×64 вообще читается как морда.

const grid = () => new Uint8Array(S * S)
// Координаты приходят от центра 31.5, то есть дробные. Запись в Uint8Array по дробному
// индексу молча ничего не делает — округляем здесь, иначе беззвучно пропадают целые слои.
const put = (px, x, y, c) => {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi >= 0 && xi < S && yi >= 0 && yi < S) px[yi * S + xi] = c
}

function ellipse(px, cy, rx, ry, c, cx = 31.5) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx; x++) {
      const u = (x - cx) / rx
      const v = (y - cy) / ry
      if (u * u + v * v <= 1) put(px, x, y, c)
    }
  }
}

function box(px, x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= Math.min(x1, HALF - 1); x++) put(px, x, y, c)
}

/** Треугольник-ухо/рог: основание внизу, вершина вверху. */
function spike(px, cx, base, height, halfWidth, c) {
  for (let i = 0; i <= height; i++) {
    const t = i / height
    const w = Math.round(halfWidth * (1 - t))
    for (let x = cx - w; x <= cx + w; x++) put(px, x, base - i, c)
  }
}

/** Контур: любой непустой пиксель, у которого сверху/снизу/сбоку пусто. */
function outline(px, c) {
  const src = px.slice()
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < HALF; x++) {
      if (!src[y * S + x]) continue
      const empty = (xx, yy) => xx < 0 || xx >= S || yy < 0 || yy >= S || !src[yy * S + xx]
      // Правый край левой половины трогать нельзя: там центральная ось, а не край фигуры.
      if (empty(x - 1, y) || (x + 1 < HALF && empty(x + 1, y)) || empty(x, y - 1) || empty(x, y + 1)) {
        put(px, x, y, c)
      }
    }
  }
}

/** Габариты головы по виду. Всё остальное — глаза, рот, шапка — считается от них. */
function headBox(f) {
  const { species, geom } = f
  const w = geom.headW
  const h = geom.headH
  switch (species) {
    case 'кот':
      return { cy: 36, rx: w, ry: h - 1 }
    case 'жаба':
      return { cy: 38, rx: w + 2, ry: h - 3 }
    case 'робот':
      return { cy: 35, rx: w - 1, ry: h, square: true }
    case 'череп':
      return { cy: 32, rx: w, ry: h - 2 }
    case 'демон':
      return { cy: 36, rx: w, ry: h }
    default:
      return { cy: 35, rx: w, ry: h }
  }
}

/** Задний слой: то, что торчит из-за головы — уши, рога, капюшон, нимб, антенна. */
function drawBehind(px, f) {
  const { species, hat } = f
  const b = headBox(f)
  const top = b.cy - b.ry

  if (hat === 'капюшон') ellipse(px, b.cy + 2, b.rx + 4, b.ry + 5, ACC)
  if (hat === 'нимб') {
    ellipse(px, top - 6, b.rx - 1, 3, ACC)
    ellipse(px, top - 6, b.rx - 5, 1, 0) // дырка кольца
  }

  switch (species) {
    case 'кот':
      spike(px, 31.5 - Math.round(b.rx * 0.55), top + 7, 11, 5, SKIN)
      break
    case 'демон':
      spike(px, 31.5 - Math.round(b.rx * 0.62), top + 5, 12, 3, ACC)
      break
    case 'робот':
      // Антенна одна и по центру: зеркалить её нельзя, иначе получаются рожки.
      box(px, 31, top - 9, 31, top, ACC2)
      ellipse(px, top - 11, 2, 2, ACC)
      break
  }
}

function drawHead(px, f) {
  const b = headBox(f)
  if (b.square) {
    box(px, Math.round(31.5 - b.rx), b.cy - b.ry, 31, b.cy + b.ry, SKIN)
  } else {
    ellipse(px, b.cy, b.rx, b.ry, SKIN)
  }
  // Челюсть черепа и глазные бугры жабы — часть силуэта, до обводки.
  if (f.species === 'череп') {
    // Морда черепа отдельно от черепной коробки — иначе очки перекрывают её и лицо исчезает.
    box(px, Math.round(31.5 - b.rx * 0.7), b.cy + 4, 31, b.cy + b.ry + 5, SKIN)
    // Носовая щель и зубы читаются только при контрасте с черепной костью.
    box(px, 28, b.cy - 1, 30, b.cy + 2, PUPIL)
    for (let x = 24; x <= 31; x += 3) box(px, x, b.cy + b.ry + 4, x, b.cy + b.ry + 5, PUPIL)
  }
  if (f.species === 'жаба') {
    ellipse(px, b.cy - b.ry - 1, 6, 6, SKIN, 31.5 - f.geom.eyeDX - 2)
  }
}

/** Полуширина головы на строке y. Нужна, чтобы рот не вылез за подбородок. */
function halfWidthAt(f, y) {
  const b = headBox(f)
  if (b.square) return b.rx
  const v = (y - b.cy) / b.ry
  return Math.abs(v) >= 1 ? 0 : b.rx * Math.sqrt(1 - v * v)
}

/** Где сидят глаза: у жабы на буграх сверху, у остальных в верхней трети головы. */
function eyeSpot(f) {
  const b = headBox(f)
  const cx = 31.5 - f.geom.eyeDX - (f.species === 'жаба' ? 2 : 0)
  const cy = f.species === 'жаба' ? b.cy - b.ry - 1 : b.cy - Math.round(b.ry * 0.18)
  return { cx, cy }
}

function drawEyes(px, f) {
  const { eyes, geom, species } = f
  const { cx, cy: y } = eyeSpot(f)
  const r = geom.eyeR + (species === 'жаба' ? 1 : 0)
  const socket = species === 'череп' ? PUPIL : SCLERA

  switch (eyes) {
    case 'щёлки':
      box(px, cx - r - 2, y, cx + r + 2, y + 1, PUPIL)
      break
    case 'квадратные':
      box(px, cx - r - 1, y - r, cx + r + 1, y + r, socket)
      box(px, cx - 1, y - 1, cx + 1, y + 1, PUPIL)
      break
    case 'полуприкрытые':
      ellipse(px, y, r + 2, r + 2, socket, cx)
      box(px, cx - r - 3, y - r - 3, cx + r + 3, y - 1, SKIN)
      box(px, cx - r - 2, y - 1, cx + r + 2, y, PUPIL)
      break
    case 'крестики':
      for (let i = -r - 1; i <= r + 1; i++) {
        put(px, cx + i, y + i, PUPIL)
        put(px, cx + i, y - i, PUPIL)
      }
      break
    case 'овальные':
      ellipse(px, y, r + 1, r + 3, socket, cx)
      ellipse(px, y + 1, r - 1, r + 1, PUPIL, cx)
      break
    case 'круглые':
    default:
      ellipse(px, y, r + 2, r + 2, socket, cx)
      ellipse(px, y, r, r, PUPIL, cx)
  }
}

function drawMouth(px, f) {
  const { mouth, geom } = f
  const b = headBox(f)
  const y = b.cy + Math.round(b.ry * 0.45) + (geom.mouthY - 42)
  // Рот шире подбородка выглядит поломкой, а не характером: режем по силуэту.
  const room = Math.max(2, Math.floor(halfWidthAt(f, y + 3)) - 2)
  const w = Math.min(geom.mouthW + 1, room)

  switch (mouth) {
    case 'улыбка':
      for (let i = 0; i <= w; i++) {
        const dy = Math.round((i * i) / (w * 1.7))
        put(px, 31 - i, y - dy, LINE)
        put(px, 31 - i, y - dy + 1, LINE)
      }
      break
    case 'хмурый':
      for (let i = 0; i <= w; i++) {
        const dy = Math.round((i * i) / (w * 1.7))
        put(px, 31 - i, y + dy, LINE)
        put(px, 31 - i, y + dy + 1, LINE)
      }
      break
    case 'открытый':
      ellipse(px, y + 1, w - 1, 4, PUPIL)
      break
    case 'зубы':
      box(px, Math.round(31.5 - w), y, 31, y + 4, PUPIL)
      for (let x = Math.round(31.5 - w) + 1; x <= 31; x += 3) box(px, x, y, x, y + 4, SCLERA)
      break
    case 'ухмылка':
      for (let i = 0; i <= w; i++) put(px, 31 - i, y - Math.round(i / 1.6), LINE)
      box(px, 31 - w, y - Math.round(w / 1.6) - 2, 31 - w + 1, y - Math.round(w / 1.6), LINE)
      break
    case 'линия':
    default:
      box(px, Math.round(31.5 - w), y, 31, y + 1, LINE)
  }
}

/** Передний слой: то, что лежит поверх головы. */
function drawHat(px, f) {
  const { hat } = f
  const b = headBox(f)
  const top = b.cy - b.ry

  switch (hat) {
    case 'кепка':
      // Тулья садится на макушку, а не парит над ней: центр внутри головы.
      ellipse(px, top + 5, b.rx - 1, 7, ACC)
      box(px, Math.round(31.5 - b.rx - 1), top + 3, 31, top + 6, ACC)
      box(px, Math.round(31.5 - b.rx - 5), top + 6, 31, top + 7, ACC2) // козырёк
      break
    case 'капюшон':
      // Сам капюшон уже в заднем слое; спереди только край, чтобы читался объём.
      for (let i = 0; i <= b.rx; i++) {
        const x = Math.round(31.5 - i)
        const dy = Math.round((i * i) / (b.rx * 1.4))
        put(px, x, top + dy - 1, ACC)
        put(px, x, top + dy, ACC)
      }
      break
    case 'рожки':
      spike(px, 31.5 - Math.round(b.rx * 0.5), top + 3, 7, 2, ACC)
      break
    case 'корона':
      box(px, Math.round(31.5 - b.rx + 2), top + 1, 31, top + 4, ACC)
      spike(px, 31.5 - b.rx + 3, top + 1, 5, 2, ACC)
      spike(px, 29, top + 1, 7, 2, ACC)
      break
  }
}

function drawWear(px, f) {
  const { wear, geom } = f
  const { cx, cy: y } = eyeSpot(f)
  const r = geom.eyeR + 3

  switch (wear) {
    case 'очки':
      box(px, cx - r, y - r, cx + r, y - r, LINE)
      box(px, cx - r, y + r, cx + r, y + r, LINE)
      box(px, cx - r, y - r, cx - r, y + r, LINE)
      box(px, cx + r, y - r, cx + r, y + r, LINE)
      box(px, cx + r + 1, y, 31, y, LINE) // перемычка
      break
    case 'тёмные':
      box(px, cx - r, y - r + 1, cx + r, y + r - 1, PUPIL)
      box(px, cx + r + 1, y - 1, 31, y, PUPIL)
      break
    case 'монокль':
      for (let a = 0; a < 96; a++) {
        const t = (a / 96) * Math.PI * 2
        put(px, Math.round(cx + Math.cos(t) * r), Math.round(y + Math.sin(t) * r), ACC)
      }
      box(px, cx, y + r + 1, cx, y + r + 5, ACC)
      break
  }
}

/** Существо целиком: индексы палитры на сетке 64×64. */
export function pixels(address) {
  const f = features(address)
  const px = grid() // всё прозрачно: иначе обводке не от чего отталкиваться

  drawBehind(px, f)
  drawHead(px, f)
  outline(px, LINE) // контур по силуэту, до того как появятся черты лица
  drawEyes(px, f)
  drawMouth(px, f)
  drawHat(px, f)
  drawWear(px, f)

  // Зеркалим левую половину направо — симметрия по построению, а не по удаче.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < HALF; x++) px[y * S + (S - 1 - x)] = px[y * S + x]
  }
  // Фон подкладывается последним, во всё, что осталось прозрачным.
  for (let i = 0; i < px.length; i++) if (!px[i]) px[i] = BG

  return { px, features: f }
}

/** Палитра: равная светлота у всех, меняется только тон — как в печати адреса. */
export function colors(f) {
  const { hue, accentHue, dark } = f
  const L = dark ? 0.6 : 0.74
  // Фон обязан быть светлее контура, иначе обводка сливается с ним и силуэт плывёт.
  return [
    'none',
    oklch(0.31, 0.045, (hue + 190) % 360), // BG
    oklch(L, 0.13, hue), // SKIN
    oklch(L - 0.13, 0.12, hue), // SHADE
    oklch(0.13, 0.035, hue), // LINE
    oklch(0.96, 0.025, hue), // SCLERA
    oklch(0.15, 0.04, hue), // PUPIL
    oklch(0.7, 0.16, accentHue), // ACC
    oklch(0.5, 0.15, accentHue), // ACC2
  ]
}

/** SVG: соседние пиксели строки сливаются в один rect, иначе файл раздувается. */
export function svg(address, { size = 256, cell = 4 } = {}) {
  const { px, features: f } = pixels(address)
  const pal = colors(f)
  let body = ''
  for (let y = 0; y < S; y++) {
    let x = 0
    while (x < S) {
      const c = px[y * S + x]
      let w = 1
      while (x + w < S && px[y * S + x + w] === c) w++
      if (c) {
        body += `<rect x="${x * cell}" y="${y * cell}" width="${w * cell}" height="${cell}" fill="${pal[c]}"/>`
      }
      x += w
    }
  }
  const side = S * cell
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${size}" height="${size}" shape-rendering="crispEdges">${body}</svg>`
}
