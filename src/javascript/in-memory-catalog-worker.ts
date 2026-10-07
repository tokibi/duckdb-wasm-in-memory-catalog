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
  const postDuckDBMessage = globalThis.postMessage;
  const gate = globalThis.DuckDBInMemoryCatalogWorkerRuntime.createDuckDBQueryGate(
    (event) => Reflect.apply(dispatchDuckDBMessage, globalThis, [event]),
    (response) => Reflect.apply(postDuckDBMessage, globalThis, [response, []]),
  );
  globalThis.postMessage = (response, transfer) => {
    if (gate.observeResponse(response)) {
      return Reflect.apply(postDuckDBMessage, globalThis, [response, transfer]);
    }
    return undefined;
  };
  const catalogStore = new globalThis.DuckDBInMemoryCatalogMetadata.InMemoryCatalogMetadataStore();
  const runtime = globalThis.DuckDBInMemoryCatalogWorkerRuntime.createInMemoryCatalogWorkerRuntime(
    catalogStore,
    gate,
  );

  globalThis.DUCKDB_IN_MEMORY_CATALOG = runtime.bridge;
  globalThis.onmessage = (event) => {
    const messageType = event?.data?.type;
    if (typeof messageType === "string" && messageType.startsWith("IN_MEMORY_CATALOG_")) {
      return runtime.handleMessage(event);
    }
    if (typeof dispatchDuckDBMessage === "function") {
      return gate.handleMessage(event);
    }
    return undefined;
  };
}
