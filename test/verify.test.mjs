// Проверка того, что верификация на explorer-е сойдётся: Standard JSON Input
// компилируется в тот же байткод, что и деплой. Если разойдётся — Basescan
// отклонит исходники, и это выяснится уже после траты газа.
import test from 'node:test'
import assert from 'node:assert/strict'
import solc from 'solc'
import { buildStandardInput, SOLC_VERSION, COMPILER_SETTINGS } from '../scripts/standard-input.mjs'
import { artifact } from './harness.mjs'

test('standard input содержит и свои контракты, и зависимости OZ', () => {
  const input = buildStandardInput()
  const paths = Object.keys(input.sources)

  assert.ok(paths.includes('contracts/FixedSupplyToken.sol'), 'нет своего контракта')
  assert.ok(
    paths.some((p) => p.startsWith('@openzeppelin/contracts/token/ERC20/ERC20.sol')),
    'не подтянулся ERC20 из OpenZeppelin',
  )
  // Транзитивные зависимости тоже обязаны попасть: ERC20 тянет Context, IERC20 и прочее.
  assert.ok(paths.length > 10, `подозрительно мало файлов: ${paths.length}`)
  for (const [path, { content }] of Object.entries(input.sources)) {
    assert.ok(content.includes('pragma solidity'), `${path} не похож на исходник Solidity`)
  }
})

test('версия solc в верификации совпадает с той, что собирает артефакты', () => {
  const actual = solc.version() // '0.8.30+commit.73712a01.Emscripten.clang'
  assert.ok(
    actual.startsWith(SOLC_VERSION.slice(1).split('.Emscripten')[0]),
    `verify.mjs шлёт ${SOLC_VERSION}, а компилирует ${actual}`,
  )
})

test('standard input компилируется в тот же байткод, что задеплоен', () => {
  const input = buildStandardInput()
  assert.deepEqual(input.settings, COMPILER_SETTINGS, 'настройки разъехались с compile.mjs')

  // Без findImport: всё, что нужно компилятору, уже лежит в sources — ровно так
  // это увидит explorer, у которого доступа к node_modules нет.
  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
  assert.deepEqual(
    errors.map((e) => e.formattedMessage),
    [],
    'standard input не компилируется сам по себе',
  )

  const compiled = output.contracts['contracts/FixedSupplyToken.sol'].FixedSupplyToken
  const deployed = artifact('FixedSupplyToken')

  assert.equal(
    `0x${compiled.evm.deployedBytecode.object}`,
    deployed.deployedBytecode,
    'байткод не совпал — верификация была бы отклонена',
  )
})
