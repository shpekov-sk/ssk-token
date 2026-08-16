// Покупка точного количества токена за ETH.
//
// Считать нужный ETH руками — источник ошибок: в одной из версий сумма в USDC
// приводилась из 6 знаков в 18 и на этом всё, без деления на курс ETH, из-за
// чего скрипт просил в 1882 раза больше денег, чем нужно.
//
// Правильно спросить у самого роутера: getAmountsIn возвращает, сколько надо
// подать на вход, чтобы получить заданный выход, по текущим резервам и с
// комиссиями. Курс при этом нигде не участвует.
//
// Обмен идёт через swapETHForExactTokens: он берёт ровно столько ETH, сколько
// нужно, а остаток возвращает. Поэтому запас на движение цены безопасен —
// лишнее не теряется.

export const EXACT_SWAP_ABI = [
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[])',
  'function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[])',
]

/**
 * @param {bigint} amountOut сколько токена нужно получить
 * @param {bigint} marginBps запас на движение цены между расчётом и блоком
 * @returns {{required: bigint, value: bigint}} нужный ETH и сумма к отправке
 */
export async function quoteExactBuy({ publicClient, router, abi, path, amountOut, marginBps = 300n }) {
  if (amountOut <= 0n) throw new Error('amountOut должен быть больше нуля')

  const amounts = await publicClient.readContract({
    address: router,
    abi,
    functionName: 'getAmountsIn',
    args: [amountOut, path],
  })

  const required = amounts[0]
  if (required <= 0n) throw new Error('роутер вернул нулевой вход — проверь путь обмена')

  return { required, value: required + (required * marginBps) / 10_000n }
}
