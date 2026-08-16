// Сид-своп через два пула: WETH -> USDC -> токен.
//
// Проверяется главное свойство: сделка, подобранная под лимит влияния, этот
// лимит не превышает после реального исполнения. Первый хоп идёт через глубокий
// пул WETH/USDC, второй — через тонкий пул токена, и весь сдвиг цены происходит
// во втором.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits, formatUnits, formatEther, parseAbi } from 'viem'
import { createChain, deploy, contractAt } from './harness.mjs'
import { deployUniswap, ROUTER_ABI, FACTORY_ABI, PAIR_ABI, reservesOf } from './uniswap.mjs'
import { impactOf, largestTradeWithin } from '../scripts/trade-impact.mjs'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DEADLINE = 2n ** 40n

const ROUTER_FULL = [
  ...ROUTER_ABI,
  ...parseAbi([
    'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[])',
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
    'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  ]),
]

// Как в Base: глубокий WETH/USDC и тонкий пул токена на $0.30 каждой стороны.
const DEEP_WETH = parseUnits('300', 18)
const DEEP_USDC = parseUnits('565000', 6)
const THIN_TOKEN = parseUnits('0.3', 18)
const THIN_USDC = parseUnits('0.3', 6)

async function setup() {
  const chain = await createChain([KEY])
  const [me] = chain.accounts
  const { weth, factory, router } = await deployUniswap(chain, me)

  const usdc = await deploy(chain, 'FixedSupplyToken', ['USD Coin', 'USDC', 6, parseUnits('10000000', 6), me.hex], me)
  const token = await deploy(chain, 'FixedSupplyToken', ['ZALUPA', 'ZLP', 18, parseUnits('1000000', 18), me.hex], me)

  await usdc.write(me, 'approve', [router.address, DEEP_USDC])
  await router.write(me, 'addLiquidityETH', [usdc.address, DEEP_USDC, 0n, 0n, me.hex, DEADLINE], DEEP_WETH)

  await usdc.write(me, 'approve', [router.address, THIN_USDC])
  await token.write(me, 'approve', [router.address, THIN_TOKEN])
  await router.write(me, 'addLiquidity', [
    token.address,
    usdc.address,
    THIN_TOKEN,
    THIN_USDC,
    THIN_TOKEN,
    THIN_USDC,
    me.hex,
    DEADLINE,
  ])

  const full = contractAt(chain, ROUTER_FULL, router.address)
  const pair = await contractAt(chain, FACTORY_ABI, factory.address).read('getPair', [token.address, usdc.address])

  return { chain, me, weth, usdc, token, router: full, pair }
}

const priceOf = async (chain, pair, token) => {
  const { token: t, quote } = await reservesOf(chain, pair, token)
  return Number(formatUnits(quote, 6)) / Number(formatUnits(t, 18))
}

test('пул токена стоит на $1.00 до сделки', async () => {
  const { chain, pair, token } = await setup()
  assert.equal(await priceOf(chain, pair, token.address), 1)
})

test('ГЛАВНОЕ: сделка под лимит 100 bps сдвигает цену не больше чем на 1%', async () => {
  const { chain, me, weth, usdc, token, router, pair } = await setup()

  const usdcIn = largestTradeWithin({ reserveIn: THIN_USDC, reserveOut: THIN_TOKEN, maxImpactBps: 100 })
  const ethIn = (await router.read('getAmountsIn', [usdcIn, [weth.address, usdc.address]]))[0]
  const path = [weth.address, usdc.address, token.address]
  const expected = (await router.read('getAmountsOut', [ethIn, path]))[2]

  assert.ok(ethIn > 0n, 'вход в ETH должен быть положительным')
  assert.ok(expected > 0n, 'что-то должно прийти')

  const before = await priceOf(chain, pair, token.address)
  await router.write(me, 'swapExactETHForTokens', [(expected * 90n) / 100n, path, me.hex, DEADLINE], ethIn)
  const after = await priceOf(chain, pair, token.address)

  const movedBps = ((after - before) / before) * 10_000
  assert.ok(movedBps > 0, 'покупка обязана поднять цену')
  assert.ok(movedBps <= 101, `цена ушла на ${movedBps.toFixed(1)} bps, лимит был 100`)
})

test('строгий лимит двигает цену ещё меньше', async () => {
  const { chain, me, weth, usdc, token, router, pair } = await setup()

  const usdcIn = largestTradeWithin({ reserveIn: THIN_USDC, reserveOut: THIN_TOKEN, maxImpactBps: 10 })
  const ethIn = (await router.read('getAmountsIn', [usdcIn, [weth.address, usdc.address]]))[0]
  const path = [weth.address, usdc.address, token.address]
  const expected = (await router.read('getAmountsOut', [ethIn, path]))[2]

  const before = await priceOf(chain, pair, token.address)
  await router.write(me, 'swapExactETHForTokens', [(expected * 90n) / 100n, path, me.hex, DEADLINE], ethIn)
  const after = await priceOf(chain, pair, token.address)

  assert.ok(((after - before) / before) * 10_000 <= 11, 'при лимите 10 bps сдвиг должен быть в пределах')
})

test('покупка за ETH не требует USDC на балансе', async () => {
  const { me, weth, usdc, token, router } = await setup()

  // Отдаём весь USDC, чтобы баланс стал нулевым.
  const balance = await usdc.read('balanceOf', [me.hex])
  await usdc.write(me, 'transfer', ['0x000000000000000000000000000000000000dEaD', balance])
  assert.equal(await usdc.read('balanceOf', [me.hex]), 0n)

  const usdcIn = largestTradeWithin({ reserveIn: THIN_USDC, reserveOut: THIN_TOKEN, maxImpactBps: 100 })
  const ethIn = (await router.read('getAmountsIn', [usdcIn, [weth.address, usdc.address]]))[0]
  const path = [weth.address, usdc.address, token.address]
  const expected = (await router.read('getAmountsOut', [ethIn, path]))[2]

  const tokensBefore = await token.read('balanceOf', [me.hex])
  await router.write(me, 'swapExactETHForTokens', [(expected * 90n) / 100n, path, me.hex, DEADLINE], ethIn)

  assert.ok((await token.read('balanceOf', [me.hex])) > tokensBefore, 'токены должны прийти без USDC на входе')
})

test('сумма сделки остаётся копеечной', async () => {
  const { weth, usdc, router } = await setup()

  const usdcIn = largestTradeWithin({ reserveIn: THIN_USDC, reserveOut: THIN_TOKEN, maxImpactBps: 100 })
  const ethIn = (await router.read('getAmountsIn', [usdcIn, [weth.address, usdc.address]]))[0]

  // ~$0.0015 при ETH около $1900 — меньше сотой цента в ETH.
  assert.ok(Number(formatEther(ethIn)) < 0.00001, `вход ${formatEther(ethIn)} ETH слишком велик`)
  assert.ok(Number(formatUnits(usdcIn, 6)) < 0.01, `${formatUnits(usdcIn, 6)} USDC слишком много`)
})
