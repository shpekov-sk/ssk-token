// Лист существ для просмотра глазами.
import { svg, features } from './critter.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const N = Number(process.argv[2] ?? 24)
const cards = []

for (let i = 0; i < N; i++) {
  const a = `0x${randomBytes(20).toString('hex')}`
  const f = features(a)
  const one = f.rarity > 0 ? Math.round(1 / f.rarity).toLocaleString('ru') : '—'
  cards.push(
    `<figure>${svg(a, { size: 168 })}<figcaption><b>${f.species}</b> · ${f.eyes} · ${f.mouth}<br>${f.hat === 'нет' ? '' : f.hat + ' · '}${f.wear === 'нет' ? '' : f.wear + ' · '}1 из ${one}</figcaption></figure>`,
  )
}

mkdirSync('marks', { recursive: true })
writeFileSync(
  'marks/critters.html',
  `<!doctype html><meta charset=utf-8><title>существа</title><style>
body{background:#0e0f12;color:#a8a59e;font:12px/1.5 ui-monospace,Menlo,monospace;padding:24px;margin:0}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:20px;max-width:1200px}
figure{margin:0}figcaption{padding-top:7px;color:#6f6c66}
b{color:#ddd9d1;font-weight:500}svg{display:block;width:100%;height:auto;border-radius:3px}
</style><main>${cards.join('')}</main>`,
)
console.log(`marks/critters.html — ${N} шт`)
