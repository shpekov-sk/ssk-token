// Печать одного адреса: node scripts/print.mjs 0x0cf1... [--out файл.svg]
//
// Без ключей и без сети — на вход только публичный адрес.
import { writeFileSync, mkdirSync } from 'node:fs'
import { getAddress } from 'viem'
import { render } from './render.mjs'
import { traits, PERFECT } from './sigil.mjs'

const argv = process.argv.slice(2)
const input = argv.find((a) => !a.startsWith('--'))

if (!input) {
  console.error('нужен адрес: node scripts/print.mjs 0x0cf1430E31B264a262aFF5fBA4D577daB5660A2a')
  console.error(`\nдля примера, эталонная печать: ${PERFECT}`)
  process.exit(1)
}

let address
try {
  address = getAddress(`0x${input.replace(/^0[xX]/, '').toLowerCase()}`)
} catch {
  console.error(`это не адрес: нужно 40 hex-символов, пришло ${input.replace(/^0[xX]/, '').length}`)
  process.exit(1)
}

const outIndex = argv.indexOf('--out')
const out = outIndex >= 0 ? argv[outIndex + 1] : `marks/${address.slice(2, 10).toLowerCase()}.svg`

mkdirSync(out.replace(/\/[^/]+$/, '') || '.', { recursive: true })
writeFileSync(out, render(address, { label: true }))

const t = traits(address)
console.log(`адрес:     ${address}`)
console.log(`печать:    ${out}`)
console.log(`счёт:      ${t.score}  (сшито ${t.links} из 64, обрывов ${t.stubs})`)
console.log(`симметрия: поворот ${t.rotation}/40, зеркало ${t.mirror}/40`)
console.log(`узор:      колец ${t.cycles}, длиннейшая линия ${t.bar}`)
