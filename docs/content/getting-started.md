---
title: Getting started
description: Set up DuckDB-Wasm, initialize the in-memory catalog, and execute your first query.
---

# Getting started

This guide walks you through setting up DuckDB-Wasm and running your first SQL query against the in-memory catalog.

> [!NOTE]
> This project is not yet published as an npm package. The examples below use pre-built JavaScript modules and browser assets built from this repository.

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
  ├── duckdb-browser-eh.worker.js         # DuckDB-Wasm Classic Worker
  └── duckdb-eh.wasm                      # DuckDB-Wasm binary (wasm_eh)
/extension/
  └── in_memory_catalog.duckdb_extension.wasm # Catalog Wasm extension
```

> [!TIP]
> See `scripts/build-pages.ts` in the repository for an example of how these assets are compiled and structured.

---

## 2. Initialize Dedicated Worker & DuckDB-Wasm

Call `createInMemoryCatalogWorker` in your main thread script to launch the combined worker:

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from '/in-memory-catalog/in-memory-catalog-controller.mjs'

// 1. Create the worker wrapping the classic DuckDB worker
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})

// 2. Instantiate DuckDB-Wasm
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
await db.instantiate('/duckdb/duckdb-eh.wasm')

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
          snapshot: 'events-v1', // Cache identity key (bump when file/schema changes)
          scanner: {
            type: 'parquet',     // 'parquet' | 'csv' | 'json' | 'xlsx'
            options: {},
          },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'event_type', type: 'VARCHAR', nullable: true },
            { name: 'created_at', type: 'TIMESTAMP', nullable: false },
          ],
          files: [
            'https://example.com/data/events-2026.parquet',
          ],
        },
      ],
      views: [
        {
          name: 'important_events',
          query: "SELECT * FROM events WHERE event_type IS NOT NULL",
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
      url: '/extension/in_memory_catalog.duckdb_extension.wasm',
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
  SELECT event_type, COUNT(*) AS count
  FROM app.analytics.events
  GROUP BY event_type
  ORDER BY count DESC
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

A self-contained HTML page demonstrating the full workflow:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DuckDB-Wasm In-Memory Catalog Quickstart</title>
</head>
<body>
  <h1>DuckDB-Wasm In-Memory Catalog</h1>
  <pre id="output">Initializing...</pre>

  <script type="module">
    import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm'
    import {
      createInMemoryCatalogWorker,
      InMemoryCatalogController,
    } from '/in-memory-catalog/in-memory-catalog-controller.mjs'

    const output = document.getElementById('output')

    try {
      // 1. Worker & DuckDB setup
      const worker = createInMemoryCatalogWorker({
        duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
      })
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
      await db.instantiate('/duckdb/duckdb-eh.wasm')
      await db.open({ allowUnsignedExtensions: true })

      // 2. Define snapshot
      const snapshot = {
        format_version: 1,
        schemas: [
          {
            name: 'main',
            tables: [
              {
                name: 'users',
                snapshot: 'v1',
                scanner: { type: 'parquet', options: {} },
                columns: [
                  { name: 'id', type: 'BIGINT', nullable: false },
                  { name: 'name', type: 'VARCHAR', nullable: true },
                ],
                files: ['https://example.com/users.parquet'],
              },
            ],
          },
        ],
      }

      // 3. Initialize catalog
      const catalog = await InMemoryCatalogController.initialize(
        db,
        worker,
        {
          catalogName: 'my_data',
          extension: { url: '/extension/in_memory_catalog.duckdb_extension.wasm' },
        },
        snapshot,
      )

      // 4. Query
      const result = await catalog.connection.query('SELECT * FROM my_data.main.users')
      output.textContent = JSON.stringify(result.toArray(), null, 2)

    } catch (err) {
      output.textContent = 'Error: ' + err.message
      console.error(err)
    }
  </script>
</body>
</html>
```

---

## Next Steps

- [**Guides**](./guides.md) — Table hot-swapping (`replaceTable`), view management, and production recipes.
- [**Scanners**](./scanners.md) — Full configuration guide for CSV, JSON, and XLSX.
- [**Concepts**](./concepts.md) — Snapshot lifecycle and cache isolation mechanics.
