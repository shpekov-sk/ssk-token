// Поиск транзакции создания контракта одним обычным RPC, без индексаторов и
// платных эндпоинтов explorer-а.
//
// Идея: код контракта появляется в блоке деплоя и остаётся навсегда. Значит
// eth_getCode монотонен по номеру блока (пусто -> есть код), и блок деплоя
// находится бинарным поиском. Дальше в этом блоке ищется сама транзакция —
// и из её calldata берутся точные аргументы конструктора.

/** Минимальный интерфейс клиента, чтобы логику можно было тестировать на заглушке. */
export async function findCreation(client, address, creationBytecode) {
  const latest = await client.getBlockNumber()

  const hasCode = async (blockNumber) => {
    const code = await client.getCode({ address, blockNumber })
    return Boolean(code && code !== '0x')
  }

  if (!(await hasCode(latest))) {
    throw new Error(`по адресу ${address} нет кода — это не контракт или он ещё не задеплоен`)
  }

  // Инвариант: в lo кода нет, в hi код есть. Сужаем, пока не станут соседними.
  let lo = 0n
  let hi = latest

  if (await hasCode(0n)) {
    lo = 0n
    hi = 0n
  } else {
    while (hi - lo > 1n) {
      const mid = lo + (hi - lo) / 2n
      if (await hasCode(mid)) hi = mid
      else lo = mid
    }
  }

  const deployBlock = hi
  const block = await client.getBlock({ blockNumber: deployBlock, includeTransactions: true })

  // Прямой деплой — транзакция без получателя. Адрес созданного контракта
  // лежит в receipt, по нему и опознаём нужную.
  const target = address.toLowerCase()
  for (const tx of block.transactions) {
    if (tx.to !== null && tx.to !== undefined) continue
    const receipt = await client.getTransactionReceipt({ hash: tx.hash })
    if (receipt.contractAddress?.toLowerCase() !== target) continue

    const input = tx.input.toLowerCase()
    const bytecode = creationBytecode.toLowerCase()

    if (!input.startsWith(bytecode)) {
      throw new Error(
        'creation bytecode в сети не совпадает с локальной сборкой — ' +
          'контракт собран из других исходников, верификация не сойдётся.\n' +
          `в сети ${input.length / 2 - 1} байт, локально ${bytecode.length / 2 - 1} байт`,
      )
    }

    return {
      blockNumber: deployBlock,
      txHash: tx.hash,
      creator: tx.from,
      constructorArgs: input.slice(bytecode.length),
    }
  }

  throw new Error(
    `в блоке ${deployBlock} не нашлось транзакции, создавшей ${address}. ` +
      'Возможно, контракт создан из другого контракта (фабрикой) — тогда аргументы ' +
      'конструктора придётся взять из explorer-а вручную.',
  )
}
