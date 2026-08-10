// Примеры печатей для README. Кладёт SVG в assets/, чтобы они попали в репозиторий
// (marks/ в .gitignore — там черновики и ключи).
import { render } from './render.mjs'
import { PERFECT } from './sigil.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { getAddress } from 'viem'

const examples = [
  ['random', '0x0cf1430E31B264a262aFF5fBA4D577daB5660A2a'],
  ['stitched', '0x7eefbbcfbeec03ff817ac2facedc45b8b1902aac'],
  ['rings', '0xdbb6fd027f9b0953dd49ee2b7f8213dff283bb76'],
  ['mirror', '0x932003714ff4ac493beabacd8a6b59f73e56c544'],
  ['perfect', PERFECT],
]

mkdirSync('assets', { recursive: true })
for (const [name, addr] of examples) {
  const file = `assets/sigil-${name}.svg`
  writeFileSync(file, render(getAddress(addr), { size: 300 }))
  console.log(file)
}
