// Production DuckDB Worker entrypoint for the In-Memory Catalog component.
{
  importScripts("./in-memory-catalog-metadata-store.js");
  importScripts("./in-memory-catalog-worker-runtime.js");

  const duckdbWorkerUrl = new URLSearchParams(globalThis.location.search).get("duckdbWorker");
  if (!duckdbWorkerUrl) {
    throw new Error(
      "The In-Memory Catalog Worker requires a duckdbWorker URL. " +
        "Create it with createInMemoryCatalogWorker({ duckdbWorker }).",
    );
  }
  importScripts(duckdbWorkerUrl);

  const dispatchDuckDBMessage = globalThis.onmessage;
  const catalogStore = new globalThis.DuckDBInMemoryCatalogMetadata.InMemoryCatalogMetadataStore();
  const runtime =
    globalThis.DuckDBInMemoryCatalogWorkerRuntime.createInMemoryCatalogWorkerRuntime(catalogStore);

  globalThis.DUCKDB_IN_MEMORY_CATALOG = runtime.bridge;
  globalThis.onmessage = (event) => {
    const messageType = event?.data?.type;
    if (typeof messageType === "string" && messageType.startsWith("IN_MEMORY_CATALOG_")) {
      return runtime.handleMessage(event);
    }
    if (typeof dispatchDuckDBMessage === "function") {
      return Reflect.apply(dispatchDuckDBMessage, globalThis, [event]);
    }
    return undefined;
  };
}
