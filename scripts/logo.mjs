// Нарезка логотипа из assets/logo-src.png в размеры, которые нужны кошелькам
// и каталогам. Исходник берётся как есть — ничего не дорисовывается.
import * as PImage from 'pureimage'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'assets')
const source = join(outDir, 'logo-src.png')

// 256 — размер, который требуют token list и trustwallet/assets;
// 32 — то, как иконка реально выглядит в списке токенов.
const SIZES = [256, 128, 64, 32]

if (!existsSync(source)) {
  console.error('нет assets/logo-src.png — положи туда исходную картинку (квадратную, от 256px)')
  process.exit(1)
}

const src = await PImage.decodePNGFromStream(createReadStream(source))

if (src.width !== src.height) {
  console.warn(`картинка не квадратная (${src.width}x${src.height}) — при нарезке будет искажение`)
}

/**
 * Уменьшение боксовым фильтром с дробными границами: работает при любом
 * соотношении сторон, в отличие от целочисленного шага.
 */
function downscale(target) {
  const out = PImage.make(target, target)
  const scaleX = src.width / target
  const scaleY = src.height / target

  for (let y = 0; y < target; y++) {
    const y0 = y * scaleY
    const y1 = (y + 1) * scaleY

    for (let x = 0; x < target; x++) {
      const x0 = x * scaleX
      const x1 = (x + 1) * scaleX
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0

      for (let sy = Math.floor(y0); sy < Math.min(Math.ceil(y1), src.height); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        for (let sx = Math.floor(x0); sx < Math.min(Math.ceil(x1), src.width); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
          const w = wx * wy
          const o = (sy * src.width + sx) * 4
          const alpha = src.data[o + 3] / 255

          // Цвет усредняем с весом альфы: иначе прозрачные пиксели затянут его в чёрный.
          r += src.data[o] * alpha * w
          g += src.data[o + 1] * alpha * w
          b += src.data[o + 2] * alpha * w
          a += alpha * w
          weight += w
        }
      }

      const o = (y * target + x) * 4
      out.data[o] = a > 0 ? r / a : 0
      out.data[o + 1] = a > 0 ? g / a : 0
      out.data[o + 2] = a > 0 ? b / a : 0
      out.data[o + 3] = (a / weight) * 255
    }
  }
  return out
}

console.log(`исходник: ${src.width}x${src.height}\n`)

for (const size of SIZES) {
  if (size > src.width) {
    console.warn(`  ${size}px пропущен — исходник меньше, апскейл только испортит картинку`)
    continue
  }
  const path = join(outDir, `logo-${size}.png`)
  await PImage.encodePNGToStream(downscale(size), createWriteStream(path))
  console.log(`  assets/logo-${size}.png`)
}
