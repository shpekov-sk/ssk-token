// Модель Uniswap V2 (x*y=k) для токена без спроса. Считает то, что обычно
// выясняют на своих деньгах: откуда берётся цена, что показывает "капитализация"
// и сколько реально можно вынуть из пула.
const FEE = 0.003

/** Сколько токенов получит покупатель, вложив quoteIn. */
function buy(x, y, quoteIn) {
  const inAfterFee = quoteIn * (1 - FEE)
  const k = x * y
  const newX = x + inAfterFee
  const newY = k / newX
  return { tokensOut: y - newY, x: newX, y: newY }
}

/** Сколько денег получит продавец, скинув tokensIn. */
function sell(x, y, tokensIn) {
  const inAfterFee = tokensIn * (1 - FEE)
  const k = x * y
  const newY = y + inAfterFee
  const newX = k / newY
  return { quoteOut: x - newX, x: newX, y: newY }
}

const spot = (x, y) => x / y
const usd = (v) => (v < 0.01 ? `$${v.toExponential(2)}` : `$${v.toFixed(2)}`)

const SUPPLY = 1_000_000

console.log('СЦЕНАРИЙ 1. Пул на твои реальные деньги: $0.50 + половина эмиссии\n')
{
  let x = 0.5,
    y = SUPPLY / 2
  console.log(`  в пуле:            ${usd(x)} и ${y.toLocaleString('ru')} токенов`)
  console.log(`  цена токена:       ${usd(spot(x, y))}`)
  console.log(`  "капитализация":   ${usd(spot(x, y) * SUPPLY)}   (цена x вся эмиссия)`)
  console.log(`  реальных денег:    ${usd(x)}          <- столько там есть на самом деле\n`)

  const b = buy(x, y, 0.1)
  console.log(`  кто-то покупает на ${usd(0.1)}:`)
  console.log(`    получает         ${Math.round(b.tokensOut).toLocaleString('ru')} токенов`)
  console.log(`    цена стала       ${usd(spot(b.x, b.y))}  (+${((spot(b.x, b.y) / spot(x, y) - 1) * 100).toFixed(0)}%)`)
  console.log(`    "капитализация"  ${usd(spot(b.x, b.y) * SUPPLY)}`)

  const s = sell(b.x, b.y, b.tokensOut)
  console.log(`    он же продаёт всё назад -> получает ${usd(s.quoteOut)} из вложенных ${usd(0.1)}\n`)
}

console.log('СЦЕНАРИЙ 2. "Высокая цена" из тонкой ликвидности\n')
{
  let x = 0.5,
    y = 1
  console.log(`  в пуле:            ${usd(x)} и ${y} токен`)
  console.log(`  цена токена:       ${usd(spot(x, y))}`)
  console.log(`  "капитализация":   ${usd(spot(x, y) * SUPPLY)}   <- миллион, при ${usd(x)} в пуле`)
  const s = sell(x, y, 10)
  console.log(`  продать 10 токенов -> ${usd(s.quoteOut)}, цена падает до ${usd(spot(s.x, s.y))}\n`)
}

console.log('СЦЕНАРИЙ 3. Сколько нужно ЧУЖИХ денег для честной капитализации $1 000 000\n')
{
  const pooled = SUPPLY / 2
  const targetPrice = 1
  console.log(`  чтобы цена была ${usd(targetPrice)} при ${pooled.toLocaleString('ru')} токенов в пуле,`)
  console.log(`  в пуле должно лежать ${usd(targetPrice * pooled)} настоящих денег.`)
  console.log(`  Эти деньги приносят покупатели. Из воздуха цена не берётся.\n`)
}

console.log('СЦЕНАРИЙ 4. Твой пул против одного продавца\n')
{
  let x = 0.5,
    y = SUPPLY / 2
  for (const share of [0.01, 0.05, 0.2]) {
    const tokens = SUPPLY * share
    const s = sell(x, y, tokens)
    console.log(
      `  держатель ${(share * 100).toFixed(0)}% эмиссии (${tokens.toLocaleString('ru')} шт.) продаёт: ` +
        `выносит ${usd(s.quoteOut)} из ${usd(x)}, цена -${((1 - spot(s.x, s.y) / spot(x, y)) * 100).toFixed(1)}%`,
    )
  }
}
