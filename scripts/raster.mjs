// Заливка контуров по правилу nonzero. Нужна потому, что pureimage заливает
// между парами пересечений (even-odd): у глифа "$" вертикальный штрих пересекает
// дугу, и на пересечении вместо заливки получается дырка.
//
// Здесь направление обхода учитывается: сумма знаков пересечений != 0 — внутри.
const SUBSAMPLES = 4

/** Ломаные из команд opentype.js: кривые дробятся на отрезки. */
export function flatten(commands, steps = 24) {
  const contours = []
  let contour = null
  let x = 0
  let y = 0

  const push = (px, py) => contour.push({ x: px, y: py })

  for (const cmd of commands) {
    if (cmd.type === 'M') {
      contour = [{ x: cmd.x, y: cmd.y }]
      contours.push(contour)
      x = cmd.x
      y = cmd.y
    } else if (cmd.type === 'L') {
      push(cmd.x, cmd.y)
      x = cmd.x
      y = cmd.y
    } else if (cmd.type === 'Q') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const u = 1 - t
        push(u * u * x + 2 * u * t * cmd.x1 + t * t * cmd.x, u * u * y + 2 * u * t * cmd.y1 + t * t * cmd.y)
      }
      x = cmd.x
      y = cmd.y
    } else if (cmd.type === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const u = 1 - t
        push(
          u ** 3 * x + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t ** 3 * cmd.x,
          u ** 3 * y + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t ** 3 * cmd.y,
        )
      }
      x = cmd.x
      y = cmd.y
    }
    // 'Z' игнорируется: контур замыкается при построении рёбер.
  }

  return contours.filter((c) => c.length > 1)
}

/** Рёбра со знаком направления — знак и даёт правило nonzero. */
function edgesOf(contours) {
  const edges = []
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      if (a.y === b.y) continue
      edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: b.y > a.y ? 1 : -1 })
    }
  }
  return edges
}

/**
 * Карта покрытия [0..1] на пиксель. Вертикальный суперсэмплинг плюс дробное
 * покрытие на краях спана — этого достаточно для сглаживания текста.
 */
export function coverage(commands, width, height) {
  const edges = edgesOf(flatten(commands))
  const cov = new Float32Array(width * height)
  if (!edges.length) return cov

  const minY = Math.max(0, Math.floor(Math.min(...edges.map((e) => Math.min(e.y0, e.y1)))))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...edges.map((e) => Math.max(e.y0, e.y1)))))
  const crossings = []

  for (let py = minY; py <= maxY; py++) {
    for (let s = 0; s < SUBSAMPLES; s++) {
      const sy = py + (s + 0.5) / SUBSAMPLES
      crossings.length = 0

      for (const e of edges) {
        const lo = Math.min(e.y0, e.y1)
        const hi = Math.max(e.y0, e.y1)
        if (sy < lo || sy >= hi) continue
        crossings.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir })
      }
      if (crossings.length < 2) continue
      crossings.sort((a, b) => a.x - b.x)

      let winding = 0
      for (let i = 0; i < crossings.length - 1; i++) {
        winding += crossings[i].dir
        if (winding === 0) continue

        const spanStart = Math.max(0, crossings[i].x)
        const spanEnd = Math.min(width, crossings[i + 1].x)
        if (spanEnd <= spanStart) continue

        const first = Math.floor(spanStart)
        const last = Math.min(width - 1, Math.floor(spanEnd - 1e-9))
        const row = py * width

        if (first === last) {
          cov[row + first] += (spanEnd - spanStart) / SUBSAMPLES
          continue
        }
        cov[row + first] += (first + 1 - spanStart) / SUBSAMPLES
        for (let px = first + 1; px < last; px++) cov[row + px] += 1 / SUBSAMPLES
        cov[row + last] += (spanEnd - last) / SUBSAMPLES
      }
    }
  }

  return cov
}

/** Кладёт цвет на bitmap pureimage по карте покрытия (source-over). */
export function fillPath(bitmap, commands, [r, g, b]) {
  const cov = coverage(commands, bitmap.width, bitmap.height)
  const data = bitmap.data

  for (let i = 0; i < cov.length; i++) {
    const alpha = Math.min(1, cov[i])
    if (alpha <= 0) continue
    const o = i * 4
    const dstA = data[o + 3] / 255
    const outA = alpha + dstA * (1 - alpha)
    data[o] = (r * alpha + data[o] * dstA * (1 - alpha)) / outA
    data[o + 1] = (g * alpha + data[o + 1] * dstA * (1 - alpha)) / outA
    data[o + 2] = (b * alpha + data[o + 2] * dstA * (1 - alpha)) / outA
    data[o + 3] = outA * 255
  }
}

/**
 * Размытие маски. Три прохода боксом дают почти гауссиану — этого достаточно
 * для свечения и заметно дешевле настоящего гаусса.
 */
export function blur(mask, width, height, radius, passes = 3) {
  let src = Float32Array.from(mask)
  let dst = new Float32Array(mask.length)

  for (let pass = 0; pass < passes; pass++) {
    boxPass(src, dst, width, height, radius, true)
    boxPass(dst, src, width, height, radius, false)
  }
  return src
}

/** Один проход бокс-фильтра бегущей суммой: стоимость не зависит от радиуса. */
function boxPass(src, dst, width, height, radius, horizontal) {
  const outer = horizontal ? height : width
  const inner = horizontal ? width : height
  const step = horizontal ? 1 : width
  const window = radius * 2 + 1

  for (let o = 0; o < outer; o++) {
    const base = horizontal ? o * width : o
    let sum = 0

    // Края продлеваем крайним значением, иначе по периметру появится тёмная кайма.
    for (let i = -radius; i <= radius; i++) sum += src[base + clamp(i, 0, inner - 1) * step]

    for (let i = 0; i < inner; i++) {
      dst[base + i * step] = sum / window
      sum -= src[base + clamp(i - radius, 0, inner - 1) * step]
      sum += src[base + clamp(i + radius + 1, 0, inner - 1) * step]
    }
  }
}

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value)
