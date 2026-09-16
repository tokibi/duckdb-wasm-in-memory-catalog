import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, it } from 'node:test'

const workerSource = await readFile(
  new URL('../../src/javascript/in-memory-catalog-worker.js', import.meta.url),
  'utf8',
)

describe('In-Memory Catalog Worker entrypoint', () => {
  it('dispatches catalog messages inline and preserves the DuckDB worker context', async () => {
    const handled = []
    let workerContext
    const context = vm.createContext({
      URLSearchParams,
      location: { search: '?duckdbWorker=duckdb-worker.js' },
      importScripts(...scripts) {
        if (scripts.includes('duckdb-worker.js')) {
          workerContext.onmessage = function onDuckDBMessage(event) {
            handled.push({ kind: 'duckdb', context: this, event })
          }
        }
      },
      DuckDBInMemoryCatalogMetadata: {
        InMemoryCatalogMetadataStore: class InMemoryCatalogMetadataStore {},
      },
      DuckDBInMemoryCatalogWorkerRuntime: {
        createInMemoryCatalogWorkerRuntime() {
          return {
            bridge: {},
            handleMessage(event) {
              handled.push({ kind: 'catalog', event })
            },
          }
        },
      },
    })
    workerContext = context

    vm.runInContext(workerSource, context, { filename: 'in-memory-catalog-worker.js' })

    const catalogEvent = { data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION' } }
    const duckdbEvent = { data: { type: 'DUCKDB_PING' } }
    await context.onmessage(catalogEvent)
    await context.onmessage(duckdbEvent)

    assert.deepEqual(handled.map(({ kind, event }) => ({ kind, event })), [
      { kind: 'catalog', event: catalogEvent },
      { kind: 'duckdb', event: duckdbEvent },
    ])
    assert.equal(handled[1].context.onmessage, context.onmessage)
    assert.equal(
      handled[1].context.DUCKDB_IN_MEMORY_CATALOG,
      context.DUCKDB_IN_MEMORY_CATALOG,
    )
    assert.deepEqual(context.DUCKDB_IN_MEMORY_CATALOG, {})
  })
})
