// Standard JSON Input — то, что explorer скармливает компилятору при верификации.
// Настройки обязаны совпадать с scripts/compile.mjs байт в байт, иначе байткод
// не сойдётся и верификация будет отклонена.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const SOLC_VERSION = 'v0.8.30+commit.73712a01'

export const COMPILER_SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'cancun',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
}

const IMPORT_RE = /import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g

function collectSources(dir, acc = {}) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSources(full, acc)
    else if (full.endsWith('.sol')) acc[full.slice(root.length + 1)] = { content: readFileSync(full, 'utf8') }
  }
  return acc
}

/** Путь импорта -> ключ в sources, как его увидит компилятор. */
function resolveImport(specifier, importerPath) {
  if (!specifier.startsWith('.')) return specifier
  // Относительные импорты (их полно внутри OpenZeppelin) считаются от файла-импортёра.
  return join(dirname(importerPath), specifier).split('\\').join('/')
}

/** Где лежит файл на диске: свои контракты в корне, зависимости в node_modules. */
function readSource(sourcePath) {
  for (const base of [root, join(root, 'node_modules')]) {
    try {
      return readFileSync(join(base, sourcePath), 'utf8')
    } catch {}
  }
  throw new Error(`не найден исходник ${sourcePath}`)
}

/**
 * Собирает вход компилятора: свои контракты плюс транзитивное замыкание импортов,
 * разложенное по тем же путям, по которым эти файлы импортируются.
 */
export function buildStandardInput() {
  const sources = collectSources(join(root, 'contracts'))
  const queue = Object.entries(sources).map(([path, { content }]) => ({ path, content }))

  while (queue.length) {
    const { path, content } = queue.pop()
    for (const match of content.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(match[1], path)
      if (sources[resolved]) continue
      const body = readSource(resolved)
      sources[resolved] = { content: body }
      queue.push({ path: resolved, content: body })
    }
  }

  return { language: 'Solidity', sources, settings: COMPILER_SETTINGS }
}
