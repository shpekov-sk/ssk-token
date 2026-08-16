import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAddress, addressFrom } from '../scripts/address.mjs'

const REAL = '0x3fbA88B5633FF26A3969e6847b5dAFa4108a6FFB'
// Та же строка с одной перепутанной буквой: именно так адрес попал в сообщение.
const TYPO = '0x3fBA88B5633FF26A3969e6847b5dAFa4108a6FFB'

test('правильный адрес проходит как есть', () => {
  const result = parseAddress(REAL)

  assert.equal(result.address, REAL)
  assert.ok(!result.error)
})

test('ГЛАВНОЕ: опечатка в регистре объясняется и показывается правильный вид', () => {
  const result = parseAddress(TYPO)

  assert.ok(result.error, 'адрес с битой суммой принимать нельзя')
  assert.match(result.error, /контрольная сумма/)
  assert.match(result.error, new RegExp(REAL), 'в сообщении должен быть правильный адрес')
})

test('адрес в одном регистре принимается и нормализуется', () => {
  assert.equal(parseAddress(REAL.toLowerCase()).address, REAL)
  assert.equal(parseAddress('0x' + REAL.slice(2).toUpperCase()).address, REAL)
})

test('пустое значение объясняет, как передать адрес', () => {
  for (const value of [undefined, null, '', '   ']) {
    const result = parseAddress(value)
    assert.match(result.error, /нужен адрес/)
    assert.match(result.error, /первым аргументом/)
  }
})

test('название параметра попадает в сообщение', () => {
  assert.match(parseAddress(undefined, 'HOLDER').error, /HOLDER=0x/)
})

test('строка без 0x отбивается отдельно от прочего мусора', () => {
  assert.match(parseAddress('3fbA88B5633FF26A3969e6847b5dAFa4108a6FFB').error, /должен начинаться с 0x/)
})

test('неверная длина называется числом символов', () => {
  assert.match(parseAddress('0xabc').error, /3 символов после 0x вместо 40/)
  assert.match(parseAddress('0x' + 'a'.repeat(41)).error, /41 символов/)
})

test('символы вне hex упоминаются явно', () => {
  const result = parseAddress('0x' + 'z'.repeat(40))
  assert.match(result.error, /вне hex/)
})

test('пробелы по краям не мешают', () => {
  assert.equal(parseAddress(`  ${REAL}  `).address, REAL)
})

test('аргумент сильнее переменной окружения', () => {
  const other = '0x0cf1430E31B264a262aFF5fBA4D577daB5660A2a'
  const result = addressFrom({ argv: [other], env: REAL })

  assert.equal(result.address, other)
})

test('без аргумента берётся переменная окружения', () => {
  assert.equal(addressFrom({ argv: [], env: REAL }).address, REAL)
})

test('флаги не путаются с адресом', () => {
  const result = addressFrom({ argv: ['--show', REAL], env: undefined })
  assert.equal(result.address, REAL)
})

test('ни аргумента, ни переменной — понятный отказ', () => {
  assert.match(addressFrom({ argv: [], env: undefined }).error, /нужен адрес/)
})
