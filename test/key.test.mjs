import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePrivateKey } from '../scripts/key.mjs'

// Тестовый ключ из документации Hardhat, публично известен — денег на нём нет.
const HEX = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

test('ключ без префикса 0x — самый частый случай, MetaMask показывает именно так', () => {
  assert.equal(normalizePrivateKey(HEX).key, `0x${HEX}`)
})

test('ключ с префиксом, в верхнем регистре и с пробелами по краям', () => {
  assert.equal(normalizePrivateKey(`  0X${HEX.toUpperCase()}\n`).key, `0x${HEX}`)
})

test('кавычки от копипасты снимаются', () => {
  assert.equal(normalizePrivateKey(`"0x${HEX}"`).key, `0x${HEX}`)
})

test('placeholder из примера не принимается за ключ', () => {
  assert.match(normalizePrivateKey('0x...').error, /placeholder/)
})

test('seed-фраза отличается от ключа и называется по имени', () => {
  const seed = 'test test test test test test test test test test test junk'
  assert.match(normalizePrivateKey(seed).error, /seed-фраза из 12 слов/)
})

test('обрезанный и слишком длинный ключ — с указанием длины', () => {
  assert.match(normalizePrivateKey(HEX.slice(0, 40)).error, /40 символов вместо 64/)
  assert.match(normalizePrivateKey(HEX + 'ab').error, /66 символов вместо 64/)
})

test('верная длина, но не hex — показывает лишние символы', () => {
  const bad = 'z'.repeat(2) + HEX.slice(2)
  assert.match(normalizePrivateKey(bad).error, /не из hex: z/)
})

test('пустое и отсутствующее значение', () => {
  assert.match(normalizePrivateKey('').error, /пустая/)
  assert.match(normalizePrivateKey(undefined).error, /пустая/)
  assert.match(normalizePrivateKey('   ').error, /пробелы/)
})
