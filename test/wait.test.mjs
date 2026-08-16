import test from 'node:test'
import assert from 'node:assert/strict'
import { waitUntil } from '../scripts/wait.mjs'

const noSleep = async () => {}

test('возвращает значение сразу, если условие уже выполнено', async () => {
  let reads = 0
  const value = await waitUntil({
    read: async () => (reads++, 100n),
    ok: (v) => v >= 100n,
    sleep: noSleep,
  })

  assert.equal(value, 100n)
  assert.equal(reads, 1, 'лишних запросов быть не должно')
})

test('дожидается отстающего узла: сначала ноль, потом нужное значение', async () => {
  const responses = [0n, 0n, 0n, 100n]
  let reads = 0

  const value = await waitUntil({
    read: async () => responses[reads++],
    ok: (v) => v >= 100n,
    sleep: noSleep,
  })

  assert.equal(value, 100n)
  assert.equal(reads, 4)
})

test('ошибки чтения не прерывают ожидание — узел мог просто отвалиться', async () => {
  const steps = [() => Promise.reject(new Error('over rate limit')), () => Promise.resolve(100n)]
  let reads = 0

  const value = await waitUntil({
    read: () => steps[reads++](),
    ok: (v) => v >= 100n,
    sleep: noSleep,
  })

  assert.equal(value, 100n)
})

test('сдаётся после заданного числа попыток и говорит, что видел', async () => {
  await assert.rejects(
    () =>
      waitUntil({
        read: async () => 0n,
        ok: (v) => v >= 100n,
        attempts: 3,
        sleep: noSleep,
      }),
    /не дождался за 3 попыток, последнее значение: 0/,
  )
})

test('в отчёт об ошибке попадает текст последнего сбоя чтения', async () => {
  await assert.rejects(
    () =>
      waitUntil({
        read: async () => {
          throw new Error('over rate limit')
        },
        ok: () => true,
        attempts: 2,
        sleep: noSleep,
      }),
    /over rate limit/,
  )
})

test('между попытками действительно ждёт', async () => {
  const delays = []
  await waitUntil({
    read: async () => (delays.length >= 2 ? 100n : 0n),
    ok: (v) => v >= 100n,
    delayMs: 1500,
    sleep: async (ms) => delays.push(ms),
  })

  assert.deepEqual(delays, [1500, 1500])
})

test('onRetry вызывается только между попытками, не после последней', async () => {
  const calls = []
  await assert.rejects(() =>
    waitUntil({
      read: async () => 0n,
      ok: () => false,
      attempts: 3,
      sleep: noSleep,
      onRetry: (attempt) => calls.push(attempt),
    }),
  )

  assert.deepEqual(calls, [1, 2], 'после последней попытки ретрай не анонсируется')
})
