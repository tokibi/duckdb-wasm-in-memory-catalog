---
title: Getting Started
description: Set up DuckDB-Wasm, initialize the in-memory catalog, and execute your first query.
---

# Getting Started

This guide walks you through setting up DuckDB-Wasm and running your first SQL query against the in-memory catalog.

> [!NOTE]
> This project is not yet published as an npm package. The examples below use pre-built JavaScript modules and browser assets built from this repository.

## Run the Quickstart Example

The repository includes a complete page that reads a local CSV file, attaches it as a catalog, and queries a view. From the repository root, run:

```sh
pnpm install --frozen-lockfile
git submodule update --init --recursive
pnpm build:wasm
pnpm build:pages
pnpm serve:pages
```

Open [http://127.0.0.1:4175/quickstart/](http://127.0.0.1:4175/quickstart/). The example uses `examples/quickstart/events.csv`; it does not fetch its query data from a remote URL. `pnpm build:wasm` requires the pinned Emscripten version in `versions.lock`. `pnpm build:pages` also fetches separate fixtures for the full demo, so a network connection is needed while building the pages.

---

## 3-Step Overview

1. **Prepare assets and initialize the Dedicated Worker with DuckDB-Wasm**
2. **Define a declarative snapshot of schemas, tables, and columns**
3. **Initialize (attach) the catalog and execute SQL queries**

---

## 1. Prepare Browser Assets

The catalog requires a custom worker entrypoint that wraps the classic DuckDB-Wasm worker script. Hosting both the catalog store and DuckDB-Wasm within the same Dedicated Worker allows the Wasm extension to synchronously query catalog metadata.

Serve the following assets from your web server or static host:

```text
/in-memory-catalog/
  ├── in-memory-catalog-controller.mjs     # Main thread controller
  ├── in-memory-catalog-worker.js         # Dedicated Worker entrypoint
  ├── in-memory-catalog-metadata-store.js # Metadata state manager
  └── in-memory-catalog-worker-runtime.js # Worker runtime bindings
/duckdb/
  ├── duckdb-browser.mjs                # DuckDB-Wasm JavaScript API
  ├── duckdb-browser-eh.worker.js         # DuckDB-Wasm Classic Worker
  └── duckdb-eh.wasm                      # DuckDB-Wasm binary (wasm_eh)
/vendor/
  ├── apache-arrow/                       # Apache Arrow JavaScript modules
  ├── flatbuffers/                        # FlatBuffers JavaScript modules
  └── tslib/                              # tslib JavaScript module
/extension/
  └── in_memory_catalog.duckdb_extension.wasm # Catalog Wasm extension
```

> [!TIP]
> See `scripts/build-pages.ts` in the repository for an example of how these assets are compiled and structured.

---

## 2. Initialize Dedicated Worker & DuckDB-Wasm

Call `createInMemoryCatalogWorker` in your main thread script to launch the combined worker:

```js
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from '../in-memory-catalog/in-memory-catalog-controller.mjs'

// This example is in examples/quickstart/app.js. Its parent directory is the built site root.
const assetRoot = new URL('../', import.meta.url)
const duckdb = await import(new URL('duckdb/duckdb-browser.mjs', assetRoot).href)
// Create a worker wrapping the classic DuckDB worker
const worker = createInMemoryCatalogWorker({
  duckdbWorker: new URL('duckdb/duckdb-browser-eh.worker.js', assetRoot),
  workerUrl: new URL('in-memory-catalog/in-memory-catalog-worker.js', assetRoot),
})

// 2. Instantiate DuckDB-Wasm
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
await db.instantiate(new URL('duckdb/duckdb-eh.wasm', assetRoot).href)

// 3. Open the database
await db.open({
  allowUnsignedExtensions: true, // Required for custom Wasm extensions
  maximumThreads: 1,
  filesystem: {
    reliableHeadRequests: false,
    allowFullHTTPReads: true,
    forceFullHTTPReads: false,
  },
})
```

> [!IMPORTANT]
> - `allowUnsignedExtensions: true` is strictly required to load custom Wasm extensions.
> - The worker script must be a **Classic Worker** (Module Workers are not supported by DuckDB-Wasm).
> - Ensure your server's CORS and CSP headers allow loading remote worker scripts and range requests.

---

## 3. Define a Snapshot

A snapshot is a pure JSON object representing your catalog's complete declarative state.

```js
const snapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'local-events-v1', // Cache identity key (bump when file/schema changes)
          scanner: {
            type: 'csv',
            options: { header: true },
          },
          columns: [
            { name: 'event_id', type: 'INTEGER', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: false },
            { name: 'value', type: 'INTEGER', nullable: false },
          ],
          files: [new URL('./events.csv', import.meta.url).href],
        },
      ],
      views: [
        {
          name: 'category_totals',
          query: "SELECT category, CAST(SUM(value) AS DOUBLE) AS total FROM events GROUP BY category",
        },
      ],
    },
  ],
}
```

- **`scanner`**: Explicitly chooses how DuckDB parses the file. No guessing based on file extension.
- **`snapshot`**: Serves as the cache invalidation key. Changing this value ensures DuckDB bypasses its internal file and Parquet caches.

---

## 4. Initialize and Attach the Catalog

`InMemoryCatalogController.initialize` loads the catalog extension, sends the snapshot to the worker, and attaches the catalog to DuckDB:

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId: crypto.randomUUID(), // Unique session ID
    catalogName: 'app',                // Catalog name in DuckDB
    extension: {
      url: new URL('extension/in_memory_catalog.duckdb_extension.wasm', assetRoot).href,
    },
  },
  snapshot,
)
```

---

## 5. Execute Queries

Query your published tables using standard 3-part identifiers:

```js
const result = await catalog.connection.query(`
  SELECT category, total
  FROM app.analytics.category_totals
  ORDER BY category
`)

console.log(result.toArray())
```

---

## 6. Cleanup

When done, close the catalog controller and shut down DuckDB:

```js
// Detach catalog and discard worker snapshot state
await catalog.close()

// Terminate DuckDB and the dedicated worker
await db.terminate()
worker.terminate()
```

---

## Complete Minimal Example

See the runnable [Quickstart page](../quickstart/) and its source in `examples/quickstart/`. It bundles a small CSV locally and demonstrates the complete setup, a table, a view, a query, and worker cleanup. Serve it over HTTP; opening the HTML directly with `file://` will not work because browser workers and Wasm assets are fetched by URL.

---

## Next Steps

- [**Guides**](./guides.md) — Table hot-swapping (`replaceTable`), view management, and production recipes.
- [**Scanners**](./scanners.md) — Full configuration guide for CSV, JSON, and XLSX.
- [**Concepts**](./concepts.md) — Snapshot lifecycle and cache isolation mechanics.
