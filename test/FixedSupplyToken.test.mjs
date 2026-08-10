import test from 'node:test'
import assert from 'node:assert/strict'
import { createChain, deploy } from './harness.mjs'
import { parseUnits, zeroAddress } from 'viem'

const KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]

const NAME = 'Fake USDT'
const SYMBOL = 'FUSDT'
const DECIMALS = 18
const SUPPLY = parseUnits('1000000', DECIMALS)

async function setup(overrides = {}) {
  const chain = await createChain(KEYS)
  const [deployer, alice, bob] = chain.accounts
  const args = {
    name: NAME,
    symbol: SYMBOL,
    decimals: DECIMALS,
    supply: SUPPLY,
    holder: deployer.hex,
    ...overrides,
  }
  const token = await deploy(
    chain,
    'FixedSupplyToken',
    [args.name, args.symbol, args.decimals, args.supply, args.holder],
    deployer,
  )
  return { chain, token, deployer, alice, bob }
}

test('метаданные и эмиссия задаются при деплое', async () => {
  const { token, deployer } = await setup()

  assert.equal(await token.read('name'), NAME)
  assert.equal(await token.read('symbol'), SYMBOL)
  assert.equal(await token.read('decimals'), DECIMALS)
  assert.equal(await token.read('totalSupply'), SUPPLY)
  assert.equal(await token.read('balanceOf', [deployer.hex]), SUPPLY)
})

test('decimals настраиваемый — 6 знаков, как у настоящего USDT', async () => {
  const supply = parseUnits('1000000', 6)
  const { token } = await setup({ decimals: 6, supply })

  assert.equal(await token.read('decimals'), 6)
  assert.equal(await token.read('totalSupply'), supply)
})

test('нельзя задеплоить с нулевым holder или нулевой эмиссией', async () => {
  await assert.rejects(() => setup({ holder: zeroAddress }), /deploy .* failed/)
  await assert.rejects(() => setup({ supply: 0n }), /deploy .* failed/)
})

test('в контракте нет привилегий: ни mint, ни owner, ни pause', async () => {
  const { token } = await setup()
  const fns = token.abi.filter((i) => i.type === 'function').map((i) => i.name)

  for (const forbidden of [/^mint/i, /owner/i, /pause/i, /blacklist|blocklist|freeze/i, /^setFee|fee$/i]) {
    assert.deepEqual(
      fns.filter((n) => forbidden.test(n)),
      [],
      `нашлась привилегированная функция: ${forbidden}`,
    )
  }
})

test('transfer двигает баланс и шлёт событие', async () => {
  const { token, deployer, alice } = await setup()
  const amount = parseUnits('1000', DECIMALS)

  const res = await token.write(deployer, 'transfer', [alice.hex, amount])

  assert.equal(await token.read('balanceOf', [alice.hex]), amount)
  assert.equal(await token.read('balanceOf', [deployer.hex]), SUPPLY - amount)

  const transfer = res.events.find((e) => e.eventName === 'Transfer')
  assert.ok(transfer, 'нет события Transfer')
  assert.equal(transfer.args.to.toLowerCase(), alice.hex)
  assert.equal(transfer.args.value, amount)
})

test('переводится ровно столько, сколько отправили — комиссии нет', async () => {
  const { token, deployer, alice } = await setup()
  const amount = parseUnits('12345.678', DECIMALS)
  const supplyBefore = await token.read('totalSupply')

  await token.write(deployer, 'transfer', [alice.hex, amount])

  assert.equal(await token.read('balanceOf', [alice.hex]), amount)
  assert.equal(await token.read('totalSupply'), supplyBefore, 'supply не должен меняться при переводе')
})

test('перевод больше баланса ревертится', async () => {
  const { token, alice, bob } = await setup()

  const res = await token.trySend(alice, 'transfer', [bob.hex, 1n])

  assert.ok(res.error)
  assert.equal(res.revert.name, 'ERC20InsufficientBalance')
  assert.equal(await token.read('balanceOf', [bob.hex]), 0n)
})

test('approve + transferFrom списывает allowance', async () => {
  const { token, deployer, alice, bob } = await setup()
  const allowance = parseUnits('500', DECIMALS)

  await token.write(deployer, 'approve', [alice.hex, allowance])
  await token.write(alice, 'transferFrom', [deployer.hex, bob.hex, parseUnits('200', DECIMALS)])

  assert.equal(await token.read('balanceOf', [bob.hex]), parseUnits('200', DECIMALS))
  assert.equal(await token.read('allowance', [deployer.hex, alice.hex]), parseUnits('300', DECIMALS))

  const res = await token.trySend(alice, 'transferFrom', [deployer.hex, bob.hex, parseUnits('400', DECIMALS)])
  assert.equal(res.revert.name, 'ERC20InsufficientAllowance')
})

test('burn уменьшает и баланс, и totalSupply', async () => {
  const { token, deployer } = await setup()
  const burn = parseUnits('1000', DECIMALS)

  await token.write(deployer, 'burn', [burn])

  assert.equal(await token.read('totalSupply'), SUPPLY - burn)
  assert.equal(await token.read('balanceOf', [deployer.hex]), SUPPLY - burn)
})

test('permit выдаёт allowance по подписи', async () => {
  const { chain, token, deployer, alice } = await setup()
  const { privateKeyToAccount } = await import('viem/accounts')

  const owner = privateKeyToAccount(KEYS[0])
  const value = parseUnits('777', DECIMALS)
  const deadline = 2n ** 48n

  const signature = await owner.signTypedData({
    domain: {
      name: NAME,
      version: '1',
      chainId: Number(chain.common.chainId()),
      verifyingContract: token.address,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: owner.address,
      spender: alice.hex,
      value,
      nonce: await token.read('nonces', [deployer.hex]),
      deadline,
    },
  })

  const r = `0x${signature.slice(2, 66)}`
  const s = `0x${signature.slice(66, 130)}`
  const v = parseInt(signature.slice(130, 132), 16)

  await token.write(alice, 'permit', [owner.address, alice.hex, value, deadline, v, r, s])

  assert.equal(await token.read('allowance', [deployer.hex, alice.hex]), value)
})

test('символы вроде $ и . не портятся при round-trip через контракт', async () => {
  const symbol = '$$K.1'
  const { token, chain, deployer, alice } = await setup({ name: symbol, symbol })

  assert.equal(await token.read('name'), symbol)
  assert.equal(await token.read('symbol'), symbol)

  // Имя участвует в EIP-712 домене для permit — проверяем, что оно там то же самое.
  const [, domainName] = await token.read('eip712Domain')
  assert.equal(domainName, symbol)

  // И что токен после этого остаётся рабочим.
  await token.write(deployer, 'transfer', [alice.hex, 1n])
  assert.equal(await token.read('balanceOf', [alice.hex]), 1n)
})

test('газ на перевод в пределах обычного ERC-20', async () => {
  const { token, deployer, alice } = await setup()

  await token.write(deployer, 'transfer', [alice.hex, parseUnits('1', DECIMALS)])
  const warm = await token.write(deployer, 'transfer', [alice.hex, parseUnits('1', DECIMALS)])

  console.log(`      transfer: ${warm.gasUsed} gas`)
  assert.ok(warm.gasUsed < 60_000n, `transfer подозрительно дорогой: ${warm.gasUsed}`)
})
