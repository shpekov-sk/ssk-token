import test from 'node:test'
import assert from 'node:assert/strict'
import { cells, addressFromCells, traits, traitsOf, ORDER, isCell, PERFECT } from '../scripts/sigil.mjs'
import { render, palette, oklch } from '../scripts/render.mjs'

const ADDR = '0x0cf1430E31B264a262aFF5fBA4D577daB5660A2a'

test('в восьмиугольнике ровно 40 клеток — по одной на hex-символ адреса', () => {
  assert.equal(ORDER.length, 40)
  assert.equal(cells(ADDR).length, 40)
})

test('форма замкнута на поворот 90°: (r,c) -> (c, 7-r) остаётся клеткой', () => {
  for (const [r, c] of ORDER) assert.ok(isCell(c, 7 - r), `(${r},${c}) уехала за край`)
})

test('печать биективна: из клеток адрес читается обратно', () => {
  assert.equal(addressFromCells(cells(ADDR)), ADDR.toLowerCase())
  assert.equal(addressFromCells(cells(PERFECT)), PERFECT)
})

test('регистр и префикс не меняют картинку — EIP-55 это только контрольная сумма', () => {
  const upper = `0x${ADDR.slice(2).toUpperCase()}`
  assert.deepEqual(cells(upper), cells(ADDR))
  assert.deepEqual(cells(ADDR.slice(2)), cells(ADDR))
  assert.equal(render(upper), render(ADDR))
})

test('не адрес — внятная ошибка, а не мусорная картинка', () => {
  assert.throws(() => cells('0x123'), /40 hex-символов/)
  assert.throws(() => cells('0x' + 'z'.repeat(40)), /40 hex-символов/)
  assert.throws(() => cells(undefined), /40 hex-символов/)
  assert.throws(() => addressFromCells([1, 2, 3]), /40 клеток/)
  assert.throws(() => addressFromCells(new Array(40).fill(16)), /вне 0\.\.15/)
})

test('эталон: сшито всё, что можно, ничего не торчит, обе симметрии полные', () => {
  const t = traits(PERFECT)
  assert.equal(t.links, 64, 'внутренних стыков в восьмиугольнике 64')
  assert.equal(t.stubs, 0)
  assert.equal(t.score, 64)
  assert.equal(t.integrity, 1)
  assert.equal(t.rotation, 40)
  assert.equal(t.mirror, 40)
  assert.equal(t.cycles, 25, 'цикломатическое число полной сетки: 64 - 40 + 1')
  assert.equal(t.bar, 8, 'самая широкая сплошная линия — целый ряд')
})

test('пустой адрес: ни линий, ни обрывов', () => {
  const t = traits(`0x${'0'.repeat(40)}`)
  assert.equal(t.links, 0)
  assert.equal(t.stubs, 0)
  assert.equal(t.ink, 0)
  assert.equal(t.leadingZeros, 40)
  assert.equal(t.cycles, 0)
  assert.equal(t.bar, 0, 'без линий длиннейшей линии нет')
})

test('дерево из линий не даёт ни одного кольца', () => {
  // Один ряд, сшитый слева направо: 7 стыков, 8 клеток, кольцо не замыкается.
  const n = new Uint8Array(40)
  const row = ORDER.map(([r], i) => [r, i]).filter(([r]) => r === 3)
  row.forEach(([, i], k) => {
    if (k > 0) n[i] |= 8 // запад
    if (k < row.length - 1) n[i] |= 2 // восток
  })
  const t = traitsOf(n)
  assert.equal(t.links, row.length - 1)
  assert.equal(t.stubs, 0)
  assert.equal(t.cycles, 0)
  assert.equal(t.bar, row.length)
})

test('счёт случайного адреса всегда далеко от эталона', () => {
  // Порог 64 недостижим (2^-160), но и близко к нему случайность не подходит.
  for (let i = 0; i < 200; i++) {
    const hex = Array.from({ length: 40 }, (_, k) => ((i * 31 + k * 7) % 16).toString(16)).join('')
    const t = traits(`0x${hex}`)
    assert.ok(t.score < 64)
    assert.ok(t.links + t.stubs <= 160)
  }
})

test('traitsOf и traits считают одно и то же', () => {
  assert.deepEqual(traitsOf(cells(ADDR)), traits(ADDR))
})

test('палитра детерминирована и держит один тон на печать', () => {
  const a = palette(ADDR)
  assert.deepEqual(a, palette(ADDR.toLowerCase()))
  assert.notEqual(a.hue, palette(PERFECT).hue)
  for (const key of ['plate', 'rim', 'ink', 'dim', 'lattice']) {
    assert.match(a[key], /^#[0-9a-f]{6}$/, `${key} должен быть валидным цветом`)
  }
})

test('oklch не выпускает канал за границы', () => {
  for (const h of [0, 90, 180, 270, 359]) {
    assert.match(oklch(0.82, 0.15, h), /^#[0-9a-f]{6}$/)
    assert.match(oklch(0.02, 0.4, h), /^#[0-9a-f]{6}$/)
  }
})

test('SVG собирается целиком и подписывается адресом в EIP-55', () => {
  const svg = render(ADDR, { label: true })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<\/svg>$/)
  assert.ok(svg.includes(ADDR), 'подпись должна быть с контрольной суммой')
  // Линии живут в path, а не в тексте группы — этот баг уже был.
  assert.doesNotMatch(svg, /<g[^>]*>M\d/)
  assert.equal(svg.match(/<path d="M/g)?.length, 2)
})
