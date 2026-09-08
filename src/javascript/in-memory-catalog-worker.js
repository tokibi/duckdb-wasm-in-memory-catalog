// Production DuckDB Worker wrapper for the In-Memory Catalog component.
importScripts('/in-memory-catalog/common-worker-router.js')
importScripts('/in-memory-catalog/in-memory-catalog-metadata-store.js')
importScripts('/in-memory-catalog/in-memory-catalog-worker-runtime.js')
importScripts('/duckdb/duckdb-browser-eh.worker.js')

const dispatchDuckDBMessage = globalThis.onmessage
const router = globalThis.DuckDBCommonWorkerRouter.createWorkerRouter(
  dispatchDuckDBMessage,
  globalThis,
)
const catalogStore = new globalThis.DuckDBInMemoryCatalogMetadata.InMemoryCatalogMetadataStore()
const runtime = globalThis.DuckDBInMemoryCatalogWorkerRuntime.createInMemoryCatalogWorkerRuntime(
  catalogStore,
)

router.registerNamespace('IN_MEMORY_CATALOG', runtime.handleMessage)
globalThis.DUCKDB_IN_MEMORY_CATALOG = runtime.bridge
globalThis.onmessage = router.handleMessage
