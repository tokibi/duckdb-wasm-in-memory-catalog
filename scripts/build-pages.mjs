import { createHash } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const outputRoot = resolve('build/pages')
const fixtureSource = 'https://blobs.duckdb.org/data/tpch-sf0.01-parquet/nation.parquet'

async function copy(source, destination) {
  await mkdir(resolve(outputRoot, destination, '..'), { recursive: true })
  await cp(resolve(source), resolve(outputRoot, destination), { recursive: true })
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

for (const file of ['index.html', 'styles.css', 'app.mjs', 'query-examples.mjs']) {
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

const fixtureResponse = await fetch(fixtureSource)
if (!fixtureResponse.ok) {
  throw new Error(`Demo Parquet download failed: HTTP ${fixtureResponse.status}`)
}
const fixtureBytes = Buffer.from(await fixtureResponse.arrayBuffer())
const fixturePath = resolve(outputRoot, 'data/demo.parquet')
await mkdir(resolve(outputRoot, 'data'), { recursive: true })
await writeFile(fixturePath, fixtureBytes)

const digest = createHash('sha256').update(fixtureBytes).digest('hex')
const metadata = {
  formatVersion: 1,
  contentVersion: digest,
  bytes: fixtureBytes.byteLength,
  rows: 25,
  columns: [
    { name: 'n_nationkey', type: 'INTEGER', nullable: true },
    { name: 'n_name', type: 'VARCHAR', nullable: true },
    { name: 'n_regionkey', type: 'INTEGER', nullable: true },
    { name: 'n_comment', type: 'VARCHAR', nullable: true },
  ],
}
await writeFile(resolve(outputRoot, 'data/demo.json'), `${JSON.stringify(metadata, null, 2)}\n`)

process.stdout.write(
  `Built GitHub Pages demo: ${metadata.rows} rows, ${fixtureBytes.byteLength.toLocaleString()} bytes\n`,
)
