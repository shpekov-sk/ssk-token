// Ожидание, пока сеть покажет уже случившееся изменение состояния.
//
// Нужно из-за рассинхрона узлов: транзакция подтверждена на одном RPC, а
// следующий запрос уходит на другой, отстающий на блок-два, и тот всё ещё
// отдаёт старое значение. С фолбэком по нескольким узлам это norma, а не
// исключение, поэтому read-after-write приходится опрашивать.

/**
 * Опрашивает read(), пока ok() не согласится или не кончатся попытки.
 * @param {() => Promise<any>} read что читаем
 * @param {(value: any) => boolean} ok когда считаем, что дождались
 * @param {(ms: number) => Promise<void>} sleep вынесено ради тестов
 */
export async function waitUntil({ read, ok, attempts = 20, delayMs = 3000, sleep = defaultSleep, onRetry }) {
  let last

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = await read()
      if (ok(last)) return last
    } catch (error) {
      last = error
    }

    if (attempt < attempts) {
      onRetry?.(attempt, last)
      await sleep(delayMs)
    }
  }

  const seen = last instanceof Error ? last.message : String(last)
  throw new Error(`не дождался за ${attempts} попыток, последнее значение: ${seen}`)
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms))
