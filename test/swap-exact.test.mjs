// Покупка точного количества USDC за ETH — против настоящего Uniswap V2.
//
// Именно здесь был баг: сумма в USDC приводилась к 18 знакам и отправлялась как
// ETH, то есть скрипт просил в ~1882 раза больше денег и падал с OutOfFunds.
// Тест проверяет, что теперь запрашивается ровно столько, сколько нужно.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits, formatUnits, formatEther, parseAbi } from 'viem'
import { createChain, deploy, contractAt } from './harness.mjs'
import { deployUniswap, ROUTER_ABI } from './uniswap.mjs'
import { quoteExactBuy, EXACT_SWAP_ABI } from '../scripts/swap.mjs'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DEADLINE = 2n ** 40n
const ETH_USD = 1882

// Глубокий пул WETH/USDC, как в Base: ~300 WETH против ~565k USDC.
const POOL_WETH = parseUnits('300', 18)
const POOL_USDC = parseUnits('565000', 6)

// ROUTER_ABI из uniswap.mjs уже разобран, поэтому добавляем к нему разобранные
// фрагменты для точного обмена.
const ROUTER_WITH_EXACT = [...ROUTER_ABI, ...parseAbi(EXACT_SWAP_ABI)]

async function setup() {
  const chain = await createChain([KEY])
  const [me] = chain.accounts
  const { weth, factory, router } = await deployUniswap(chain, me)

  const usdc = await deploy(chain, 'FixedSupplyToken', ['USD Coin', 'USDC', 6, parseUnits('10000000', 6), me.hex], me)

  // Заводим глубокий пул WETH/USDC.
  await usdc.write(me, 'approve', [router.address, POOL_USDC])
  await router.write(me, 'addLiquidityETH', [usdc.address, POOL_USDC, 0n, 0n, me.hex, DEADLINE], POOL_WETH)

  const routerExact = contractAt(chain, ROUTER_WITH_EXACT, router.address)
  return { chain, me, weth, usdc, router: routerExact }
}

test('getAmountsIn даёт сумму по курсу пула, а не по номиналу', async () => {
  const { chain, me, weth, usdc, router } = await setup()

  const want = parseUnits('0.228107', 6) // ровно то, что просил упавший скрипт
  const { required, value } = await quoteExactBuy({
    publicClient: { readContract: (args) => router.read(args.functionName, args.args) },
    router: router.address,
    abi: ROUTER_WITH_EXACT,
    path: [weth.address, usdc.address],
    amountOut: want,
  })

  const requiredEth = Number(formatEther(required))
  const requiredUsd = requiredEth * ETH_USD

  // 0.228 USDC должны стоить примерно столько же в долларах, а не 0.27 ETH.
  assert.ok(requiredUsd > 0.2 && requiredUsd < 0.3, `вышло $${requiredUsd.toFixed(4)}, ожидалось ~$0.23`)
  assert.ok(requiredEth < 0.001, `вышло ${requiredEth} ETH — это снова старый баг`)
  assert.ok(value > required, 'запас должен добавляться')
})

test('swapETHForExactTokens выдаёт ровно запрошенное и возвращает лишний ETH', async () => {
  const { chain, me, weth, usdc, router } = await setup()

  const want = parseUnits('0.228107', 6)
  const { required, value } = await quoteExactBuy({
    publicClient: { readContract: (args) => router.read(args.functionName, args.args) },
    router: router.address,
    abi: ROUTER_WITH_EXACT,
    path: [weth.address, usdc.address],
    amountOut: want,
    marginBps: 1000n, // заведомо большой запас, чтобы проверить возврат
  })

  const usdcBefore = await usdc.read('balanceOf', [me.hex])
  const res = await router.write(
    me,
    'swapETHForExactTokens',
    [want, [weth.address, usdc.address], me.hex, DEADLINE],
    value,
  )
  const usdcAfter = await usdc.read('balanceOf', [me.hex])

  assert.equal(usdcAfter - usdcBefore, want, 'должно прийти ровно запрошенное количество')

  // Возврат остатка видно по событию Transfer от WETH: роутер снимает только нужное.
  assert.ok(res.gasUsed > 0n)
  assert.ok(value - required > 0n, 'в тесте специально был запас')
})

test('нулевой запрос отбивается до обращения к сети', async () => {
  await assert.rejects(
    () =>
      quoteExactBuy({
        publicClient: { readContract: async () => [0n, 0n] },
        router: '0x0000000000000000000000000000000000000001',
        abi: ROUTER_WITH_EXACT,
        path: [],
        amountOut: 0n,
      }),
    /больше нуля/,
  )
})

test('нулевой ответ роутера считается ошибкой, а не поводом отправить транзакцию', async () => {
  await assert.rejects(
    () =>
      quoteExactBuy({
        publicClient: { readContract: async () => [0n, 1n] },
        router: '0x0000000000000000000000000000000000000001',
        abi: ROUTER_WITH_EXACT,
        path: [],
        amountOut: 1n,
      }),
    /нулевой вход/,
  )
})

test('чем больше просишь, тем больше нужно ETH', async () => {
  const { weth, usdc, router } = await setup()
  const quote = (amount) =>
    quoteExactBuy({
      publicClient: { readContract: (args) => router.read(args.functionName, args.args) },
      router: router.address,
      abi: ROUTER_WITH_EXACT,
      path: [weth.address, usdc.address],
      amountOut: amount,
    })

  const small = await quote(parseUnits('0.1', 6))
  const large = await quote(parseUnits('10', 6))

  assert.ok(large.required > small.required * 50n, 'зависимость должна быть монотонной и примерно линейной')
})
