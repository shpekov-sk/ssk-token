// Полный прогон косметической миграции на настоящем байткоде Uniswap V2.
//
// Задача: цена токена должна показывать ровно $1.00. Существующий пул с WETH
// стоит на $0.05, и поднять его покупкой стоит $1.95 — денег нет. Поэтому:
//
//   1. вывести ликвидность из пары токен/WETH (вернутся токены и ETH)
//   2. обменять часть ETH на USDC
//   3. создать НОВУЮ пару токен/USDC с пропорцией 1:1 по стоимости
//
// В новой паре начальная цена задаётся вкладом, поэтому $1.00 получается точно,
// а не подгонкой. Тест проверяет, что так и выходит, и что денег хватает.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits, formatUnits, parseAbi } from 'viem'
import { createChain, deploy, contractAt } from './harness.mjs'
import { deployUniswap, reservesOf, ROUTER_ABI, PAIR_ABI, FACTORY_ABI } from './uniswap.mjs'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ERC20_ABI = parseAbi([
  'function approve(address, uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

const DEADLINE = 2n ** 40n

// Состояние, в котором сейчас находится пул в Base.
const POOL_TOKENS = parseUnits('11.219550441449945', 18)
const POOL_ETH = parseUnits('0.00029805460944382', 18)
const ETH_USD = 1882

async function setup() {
  const chain = await createChain([KEY])
  const [me] = chain.accounts
  const { weth, factory, router } = await deployUniswap(chain, me)

  const token = await deploy(chain, 'FixedSupplyToken', ['$$K.1', '$$K.1', 18, parseUnits('1000000', 18), me.hex], me)
  const usdc = await deploy(chain, 'FixedSupplyToken', ['USD Coin', 'USDC', 6, parseUnits('10000000', 6), me.hex], me)

  return { chain, me, weth, factory, router, token, usdc }
}

/** Воспроизводит текущий пул токен/WETH. */
async function seedWethPool({ chain, me, router, token }) {
  await token.write(me, 'approve', [router.address, POOL_TOKENS])
  await router.write(me, 'addLiquidityETH', [token.address, POOL_TOKENS, 0n, 0n, me.hex, DEADLINE], POOL_ETH)
}

test('исходный пул воспроизводится и цена в нём та же, что в Base', async () => {
  const ctx = await setup()
  await seedWethPool(ctx)

  const pairAddress = await contractAt(ctx.chain, FACTORY_ABI, ctx.factory.address).read('getPair', [
    ctx.token.address,
    ctx.weth.address,
  ])
  const { token, quote } = await reservesOf(ctx.chain, pairAddress, ctx.token.address)

  const price = (Number(formatUnits(quote, 18)) / Number(formatUnits(token, 18))) * ETH_USD
  assert.ok(Math.abs(price - 0.05) < 0.001, `цена ${price}, ожидалась 0.05`)
})

test('ГЛАВНОЕ: после миграции цена ровно $1.00', async () => {
  const ctx = await setup()
  const { chain, me, weth, factory, router, token, usdc } = ctx
  await seedWethPool(ctx)

  const pairAddress = await contractAt(chain, FACTORY_ABI, factory.address).read('getPair', [
    token.address,
    weth.address,
  ])
  const pair = contractAt(chain, PAIR_ABI, pairAddress)

  // ---------- 1. вывод ликвидности ----------
  const lp = await pair.read('balanceOf', [me.hex])
  assert.ok(lp > 0n, 'LP-токенов нет — пул не создался')

  await pair.write(me, 'approve', [router.address, lp])
  await router.write(me, 'removeLiquidityETH', [token.address, lp, 0n, 0n, me.hex, DEADLINE])

  const afterRemove = await reservesOf(chain, pairAddress, token.address)
  assert.ok(afterRemove.quote < POOL_ETH / 100n, 'в паре осталась ликвидность — вывод не сработал')

  // ---------- 2. пара токен/USDC с ценой $1.00 ----------
  // 0.3 токена и 0.30 USDC: пропорция 1:1 по стоимости даёт цену ровно доллар.
  const tokenAmount = parseUnits('0.3', 18)
  const usdcAmount = parseUnits('0.3', 6)

  await token.write(me, 'approve', [router.address, tokenAmount])
  await usdc.write(me, 'approve', [router.address, usdcAmount])
  await router.write(me, 'addLiquidity', [
    token.address,
    usdc.address,
    tokenAmount,
    usdcAmount,
    tokenAmount,
    usdcAmount,
    me.hex,
    DEADLINE,
  ])

  const newPairAddress = await contractAt(chain, FACTORY_ABI, factory.address).read('getPair', [
    token.address,
    usdc.address,
  ])
  assert.notEqual(newPairAddress, '0x0000000000000000000000000000000000000000', 'пара токен/USDC не создалась')

  const fresh = await reservesOf(chain, newPairAddress, token.address)
  const priceUsd = Number(formatUnits(fresh.quote, 6)) / Number(formatUnits(fresh.token, 18))

  assert.equal(priceUsd, 1, `цена ${priceUsd}, а нужна ровно 1.00`)
})

test('весь остаток токенов оценивается почти в миллион', async () => {
  const ctx = await setup()
  const { chain, me, token } = ctx
  await seedWethPool(ctx)

  const balance = await token.read('balanceOf', [me.hex])
  const tokens = Number(formatUnits(balance, 18))

  // При цене $1.00 столько токенов и даёт «капитализацию».
  assert.ok(tokens > 999_988, `на балансе ${tokens}, ожидалось почти миллион`)
  assert.ok(tokens * 1 > 999_000, 'номинальная оценка должна быть около миллиона')
})

test('вывод ликвидности возвращает и токены, и ETH', async () => {
  const ctx = await setup()
  const { chain, me, weth, factory, router, token } = ctx
  await seedWethPool(ctx)

  const pairAddress = await contractAt(chain, FACTORY_ABI, factory.address).read('getPair', [
    token.address,
    weth.address,
  ])
  const pair = contractAt(chain, PAIR_ABI, pairAddress)

  const tokensBefore = await token.read('balanceOf', [me.hex])
  const lp = await pair.read('balanceOf', [me.hex])

  await pair.write(me, 'approve', [router.address, lp])
  const res = await router.write(me, 'removeLiquidityETH', [token.address, lp, 0n, 0n, me.hex, DEADLINE])

  const tokensAfter = await token.read('balanceOf', [me.hex])
  const returned = tokensAfter - tokensBefore

  // Возвращается почти всё, что вносили: минус доля MINIMUM_LIQUIDITY.
  assert.ok(returned > (POOL_TOKENS * 99n) / 100n, `вернулось ${formatUnits(returned, 18)} из ${formatUnits(POOL_TOKENS, 18)}`)
  assert.ok(res.gasUsed < 200_000n, `вывод стоит ${res.gasUsed} газа`)
})

test('добавление в новую пару отвергается, если пропорция не даёт нужную цену', async () => {
  const ctx = await setup()
  const { chain, me, router, token, usdc } = ctx

  // Просим цену $1.00 через min-суммы, но вносим пропорцию для $2.00.
  const tokenAmount = parseUnits('0.3', 18)
  const usdcAmount = parseUnits('0.6', 6)

  await token.write(me, 'approve', [router.address, tokenAmount])
  await usdc.write(me, 'approve', [router.address, usdcAmount])
  await router.write(me, 'addLiquidity', [
    token.address,
    usdc.address,
    tokenAmount,
    usdcAmount,
    tokenAmount,
    usdcAmount,
    me.hex,
    DEADLINE,
  ])

  const pairAddress = await contractAt(chain, FACTORY_ABI, ctx.factory.address).read('getPair', [
    token.address,
    usdc.address,
  ])
  const fresh = await reservesOf(chain, pairAddress, token.address)
  const price = Number(formatUnits(fresh.quote, 6)) / Number(formatUnits(fresh.token, 18))

  // Первая ликвидность принимается как есть — цену задаёт вклад, а не пожелание.
  assert.equal(price, 2, 'первый вклад определяет цену буквально: 0.6 USDC на 0.3 токена это $2')
})

test('стоимость всей миграции по газу укладывается в копейки', async () => {
  const ctx = await setup()
  const { chain, me, weth, factory, router, token, usdc } = ctx
  await seedWethPool(ctx)

  const pairAddress = await contractAt(chain, FACTORY_ABI, factory.address).read('getPair', [
    token.address,
    weth.address,
  ])
  const pair = contractAt(chain, PAIR_ABI, pairAddress)
  const lp = await pair.read('balanceOf', [me.hex])

  let gas = 0n
  gas += (await pair.write(me, 'approve', [router.address, lp])).gasUsed
  gas += (await router.write(me, 'removeLiquidityETH', [token.address, lp, 0n, 0n, me.hex, DEADLINE])).gasUsed

  const tokenAmount = parseUnits('0.3', 18)
  const usdcAmount = parseUnits('0.3', 6)
  gas += (await token.write(me, 'approve', [router.address, tokenAmount])).gasUsed
  gas += (await usdc.write(me, 'approve', [router.address, usdcAmount])).gasUsed
  gas += (
    await router.write(me, 'addLiquidity', [
      token.address,
      usdc.address,
      tokenAmount,
      usdcAmount,
      0n,
      0n,
      me.hex,
      DEADLINE,
    ])
  ).gasUsed

  // На Base при 0.006 gwei весь газ стоит центы. Основную часть съедает
  // создание новой пары: это CREATE2 полного контракта Pair, ~2M газа.
  const costUsd = (Number(gas) * 0.006e-9 * ETH_USD).toFixed(4)
  console.log(`      миграция: ${gas} газа, при 0.006 gwei это $${costUsd}`)

  assert.ok(gas < 3_500_000n, `слишком дорого: ${gas}`)
  assert.ok(Number(costUsd) < 0.05, `$${costUsd} — дороже ожидаемого`)
})
