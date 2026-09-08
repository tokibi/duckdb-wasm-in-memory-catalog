import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const outputRoot = resolve('build/pages')

async function copy(source, destination) {
  await mkdir(resolve(outputRoot, destination, '..'), { recursive: true })
  await cp(resolve(source), resolve(outputRoot, destination), { recursive: true })
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

for (const file of ['index.html', 'styles.css', 'app.mjs']) {
  await copy(`demo/${file}`, file)
}
await writeFile(resolve(outputRoot, '.nojekyll'), '')

await copy(
  'src/javascript/in-memory-catalog-controller.mjs',
  'in-memory-catalog/in-memory-catalog-controller.mjs',
)
await copy('src/javascript/common-worker-router.js', 'in-memory-catalog/common-worker-router.js')
await copy(
  'src/javascript/in-memory-catalog-metadata-store.js',
  'in-memory-catalog/in-memory-catalog-metadata-store.js',
)
await copy(
  'src/javascript/in-memory-catalog-worker-runtime.js',
  'in-memory-catalog/in-memory-catalog-worker-runtime.js',
)
await copy('demo/in-memory-catalog-worker.js', 'in-memory-catalog/in-memory-catalog-worker.js')

await copy('node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs', 'duckdb/duckdb-browser.mjs')
await copy('node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', 'duckdb/duckdb-eh.wasm')
await copy(
  'node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js',
  'duckdb/duckdb-browser-eh.worker.js',
)
await copy('node_modules/apache-arrow', 'vendor/apache-arrow')
await copy('node_modules/flatbuffers/mjs', 'vendor/flatbuffers')
await copy('node_modules/tslib/tslib.es6.mjs', 'vendor/tslib/tslib.es6.mjs')
await copy(
  'build/wasm_eh/extension/in_memory_catalog/in_memory_catalog.duckdb_extension.wasm',
  'extension/in_memory_catalog.duckdb_extension.wasm',
)

const fixturePath = resolve(outputRoot, 'data/demo.parquet')
await mkdir(resolve(outputRoot, 'data'), { recursive: true })
const sqlPath = fixturePath.replaceAll("'", "''")
const fixtureRows = 50_000
const fixtureSql = `
COPY (
  SELECT
    i::BIGINT AS id,
    (i % 8)::INTEGER AS group_id,
    CASE (i % 4)
      WHEN 0 THEN 'alpha'
      WHEN 1 THEN 'beta'
      WHEN 2 THEN 'gamma'
      ELSE 'delta'
    END::VARCHAR AS category,
    round((sin(i * 0.017) * 50) + (i % 8), 3)::DOUBLE AS metric
  FROM range(0, ${fixtureRows}) AS t(i)
) TO '${sqlPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000);
`

await execFileAsync(resolve('build/native/duckdb'), ['-c', fixtureSql])

const fixtureBytes = await readFile(fixturePath)
const fixtureStat = await stat(fixturePath)
const digest = createHash('sha256').update(fixtureBytes).digest('hex')
const metadata = {
  formatVersion: 1,
  contentVersion: digest,
  bytes: fixtureStat.size,
  rows: fixtureRows,
  columns: [
    { name: 'id', type: 'BIGINT', nullable: true },
    { name: 'group_id', type: 'INTEGER', nullable: true },
    { name: 'category', type: 'VARCHAR', nullable: true },
    { name: 'metric', type: 'DOUBLE', nullable: true },
  ],
}
await writeFile(resolve(outputRoot, 'data/demo.json'), `${JSON.stringify(metadata, null, 2)}\n`)

process.stdout.write(
  `Built GitHub Pages demo: ${fixtureRows.toLocaleString()} rows, ${fixtureStat.size.toLocaleString()} bytes\n`,
)
