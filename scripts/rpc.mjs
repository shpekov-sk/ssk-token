// Транспорт до сети с запасными узлами. Публичные RPC регулярно отдают
// «over rate limit», особенно официальный mainnet.base.org — на нём сидят все.
// viem по списку сам переключается на следующий узел и повторяет запрос.
import { fallback, http } from 'viem'

// Проверенные публичные узлы, в дополнение к дефолтному из viem/chains.
const EXTRA_ENDPOINTS = {
  8453: [
    // Base mainnet
    'https://base.llamarpc.com',
    'https://base-rpc.publicnode.com',
    'https://base.drpc.org',
    'https://1rpc.io/base',
  ],
  84532: [
    // Base Sepolia
    'https://base-sepolia-rpc.publicnode.com',
    'https://base-sepolia.drpc.org',
  ],
  1: ['https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com'],
  10: ['https://optimism.llamarpc.com', 'https://optimism-rpc.publicnode.com'],
  42161: ['https://arbitrum.llamarpc.com', 'https://arbitrum-one-rpc.publicnode.com'],
}

/**
 * Список узлов: сначала явно заданный, потом дефолтный из viem, потом запасные.
 * Дубли убираются, чтобы фолбэк не тратил попытки на один и тот же адрес.
 */
export function endpointsFor(chain, rpcUrl) {
  const candidates = [
    ...(rpcUrl ? [rpcUrl] : []),
    ...(chain.rpcUrls?.default?.http ?? []),
    ...(EXTRA_ENDPOINTS[chain.id] ?? []),
  ]

  return [...new Set(candidates.map((url) => url.replace(/\/+$/, '')))]
}

/**
 * Транспорт с повторами. rank: false — порядок сохраняется, то есть свой узел
 * (если задан) всегда пробуется первым, а не «самый быстрый».
 */
export function transportFor(chain, rpcUrl) {
  const endpoints = endpointsFor(chain, rpcUrl)

  return fallback(
    endpoints.map((url) => http(url, { retryCount: 2, retryDelay: 400, timeout: 20_000 })),
    { rank: false, retryCount: 1 },
  )
}
