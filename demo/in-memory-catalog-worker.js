importScripts('./common-worker-router.js')
importScripts('./in-memory-catalog-metadata-store.js')
importScripts('./in-memory-catalog-worker-runtime.js')

const duckdbWorkerUrl = new URLSearchParams(globalThis.location.search).get('duckdbWorker')
if (!duckdbWorkerUrl) {
  throw new Error('The demo In-Memory Catalog Worker requires a duckdbWorker URL')
}
importScripts(duckdbWorkerUrl)

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
