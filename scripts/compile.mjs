// Компиляция контрактов через solc-js. Отдаёт artifacts/<Contract>.json (abi + bytecode).
import solc from 'solc'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPILER_SETTINGS } from './standard-input.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.sol') ? [full] : []
  })
}

const sources = Object.fromEntries(
  walk(join(root, 'contracts')).map((file) => [
    file.slice(root.length + 1),
    { content: readFileSync(file, 'utf8') },
  ]),
)

// solc не умеет ходить по файловой системе сам — импорты резолвим здесь.
function findImport(path) {
  for (const base of [join(root, 'node_modules'), root]) {
    try {
      return { contents: readFileSync(join(base, path), 'utf8') }
    } catch {}
  }
  return { error: `not found: ${path}` }
}

// Настройки общие с верификацией: разойдутся — explorer не сойдётся по байткоду.
const input = { language: 'Solidity', sources, settings: COMPILER_SETTINGS }

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }))

const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
const warnings = (output.errors ?? []).filter((e) => e.severity === 'warning')
for (const w of warnings) console.warn(w.formattedMessage.trimEnd())
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage.trimEnd())
  process.exit(1)
}

const outDir = join(root, 'artifacts')
mkdirSync(outDir, { recursive: true })

let count = 0
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, contract] of Object.entries(contracts)) {
    writeFileSync(
      join(outDir, `${name}.json`),
      JSON.stringify(
        {
          contractName: name,
          sourceName: file,
          abi: contract.abi,
          bytecode: `0x${contract.evm.bytecode.object}`,
          deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        },
        null,
        2,
      ),
    )
    const size = contract.evm.deployedBytecode.object.length / 2
    console.log(`  ${name.padEnd(20)} ${String(size).padStart(6)} bytes deployed`)
    count++
  }
}

console.log(`compiled ${count} contracts (solc ${solc.version()})`)
