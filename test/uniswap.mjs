// Локальный Uniswap V2 из настоящего байткода: фабрика, роутер, WETH.
//
// Зачем не мок: мок повторяет мои представления о Uniswap, а не Uniswap.
// Проверять последовательность транзакций, которая пойдёт в мейннет, надо на
// том же коде, что там работает.
//
// UniswapV2Library вычисляет адрес пары через CREATE2 с захардкоженным хешем
// init-кода Pair. Сборка из npm совпадает с канонической (проверяется ниже),
// поэтому роутер находит локальные пары там же, где ожидает.
import { keccak256, parseAbi } from 'viem'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contractAt } from './harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CANONICAL_PAIR_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f'

const artifact = (path) => JSON.parse(readFileSync(join(root, 'node_modules', path), 'utf8'))

/** Артефакты Uniswap хранят байткод без префикса 0x, viem его требует. */
const hex = (value) => (value.startsWith('0x') ? value : `0x${value}`)

const FACTORY = artifact('@uniswap/v2-core/build/UniswapV2Factory.json')
const PAIR = artifact('@uniswap/v2-core/build/UniswapV2Pair.json')
const ROUTER = artifact('@uniswap/v2-periphery/build/UniswapV2Router02.json')
const WETH9 = artifact('@uniswap/v2-periphery/build/WETH9.json')

export const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
])

export const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256, uint256)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
])

const FACTORY_ABI = parseAbi([
  'function createPair(address, address) returns (address)',
  'function getPair(address, address) view returns (address)',
])

/** Разворачивает фабрику, WETH и пропатченный роутер на локальном EVM. */
export async function deployUniswap(chain, from = chain.accounts[0]) {
  const { encodeDeployData } = await import('viem')

  // Деплоим по ABI из артефакта — в нём есть конструктор; работаем потом по своему.
  const deployRaw = async (bytecode, deployAbi, callAbi, args = []) => {
    const res = await chain.send(from, { data: encodeDeployData({ abi: deployAbi, bytecode, args }) })
    if (res.error) throw new Error(`деплой не прошёл: ${res.error}`)
    return contractAt(chain, callAbi, res.createdAddress)
  }

  const weth = await deployRaw(hex(WETH9.bytecode), WETH9.abi, WETH9.abi)
  const factory = await deployRaw(hex(FACTORY.bytecode), FACTORY.abi, FACTORY_ABI, [from.hex])

  // Если сборка Pair разойдётся с канонической, роутер начнёт искать пары по
  // другим адресам и все вызовы будут молча падать — проверяем сразу.
  const pairHash = keccak256(hex(PAIR.bytecode))
  if (pairHash.toLowerCase() !== CANONICAL_PAIR_HASH) {
    throw new Error(`сборка Pair не каноническая: ${pairHash}. Роутер не найдёт локальные пары.`)
  }

  const router = await deployRaw(hex(ROUTER.bytecode), ROUTER.abi, ROUTER_ABI, [factory.address, weth.address])

  return { weth, factory, router }
}

/** Резервы пары, приведённые к порядку (токен, квота). */
export async function reservesOf(chain, pairAddress, tokenAddress) {
  const pair = contractAt(chain, PAIR_ABI, pairAddress)
  const [r0, r1] = await pair.read('getReserves')
  const token0 = await pair.read('token0')

  const tokenIsZero = token0.toLowerCase() === tokenAddress.toLowerCase()
  return { token: tokenIsZero ? r0 : r1, quote: tokenIsZero ? r1 : r0, pair }
}

export { FACTORY_ABI, PAIR }
