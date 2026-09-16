---
title: Getting started
description: Set up DuckDB-Wasm, initialize the in-memory catalog, and run your first query.
---

# Getting started

This guide shows the shortest path from a DuckDB-Wasm database to a queryable in-memory catalog.

> [!NOTE]
> The repository is not published as an npm package yet. The examples below use the browser assets produced by this repository. When integrating into another build, keep the same module and Worker boundaries.

## 1. Prepare the browser assets

The catalog needs a custom Worker entrypoint that loads the classic DuckDB-Wasm Worker script. Provide the classic Worker URL belonging to the DuckDB-Wasm bundle selected by your application. The entrypoint loads that script into the same Dedicated Worker so the catalog extension can synchronously access its metadata bridge.

Serve these assets from your application:

```text
/in-memory-catalog/in-memory-catalog-controller.mjs
/in-memory-catalog/in-memory-catalog-worker.js
/in-memory-catalog/in-memory-catalog-metadata-store.js
/in-memory-catalog/in-memory-catalog-worker-runtime.js
/duckdb/duckdb-browser-eh.worker.js
/duckdb/duckdb-eh.wasm
/extension/in_memory_catalog.duckdb_extension.wasm
```

The `duckdb` files must come from a compatible `@duckdb/duckdb-wasm` version, and the catalog extension must be built for that DuckDB version and the `wasm_eh` platform. The repository's `scripts/build-pages.mjs` shows one concrete way to assemble the assets.

## 2. Create DuckDB-Wasm with the catalog Worker

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from '/in-memory-catalog/in-memory-catalog-controller.mjs'

const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)

await db.instantiate('/duckdb/duckdb-eh.wasm')
await db.open({
  allowUnsignedExtensions: true,
  maximumThreads: 1,
  filesystem: {
    reliableHeadRequests: false,
    allowFullHTTPReads: true,
    forceFullHTTPReads: false,
  },
})
```

The same Worker is used by DuckDB-Wasm and the catalog controller. A normal DuckDB browser Worker is not sufficient because it does not handle the catalog's namespaced metadata messages. The supplied URL must point to a classic DuckDB-Wasm Worker; module Workers are not supported by this entrypoint. The Worker script and all imported catalog scripts must be reachable under your CSP and have the required same-origin/CORS permissions.

`allowUnsignedExtensions` is required when loading the locally built Wasm extension.

## 3. Define a snapshot

A snapshot is the complete catalog state that the Worker publishes atomically.

```js
const snapshot = {
  format_version: 2,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'events-r1',
          scanner: {
            type: 'parquet',
            options: {},
          },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: true },
          ],
          files: [
            { uri: 'https://example.com/events.parquet' },
          ],
        },
      ],
    },
  ],
}
```

The catalog does not infer a scanner from the filename or URI. Every table declares its scanner explicitly. Use `type: 'csv'` for CSV files and provide CSV options when the file needs a non-default delimiter, header behavior, or other supported read setting. See [Scanners](./scanners.md) for the available options.

## 4. Initialize the catalog

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId: crypto.randomUUID(),
    catalogName: 'app',
    extension: {
      url: '/extension/in_memory_catalog.duckdb_extension.wasm',
    },
  },
  snapshot,
)
```

Initialization loads Parquet support, loads the in-memory catalog extension, publishes the initial snapshot, and attaches the catalog read-only. You can instead install an extension from a compatible repository with `extension: { name: 'in_memory_catalog', repository: 'https://example.test/extensions' }`; this emits DuckDB's `INSTALL ... FROM ...` followed by `LOAD ...`. The repository must provide a binary matching the selected DuckDB-Wasm version and `wasm_eh` platform.

## 5. Query it

```js
const result = await catalog.connection.query(`
  SELECT id, category
  FROM app.analytics.events
`)
```

Use `catalog.connection` for queries that need the attached catalog.

## 6. Clean up

```js
await catalog.close()
await db.terminate()
worker.terminate()
```

Closing the controller detaches the catalog and drops its Worker-side snapshot. It does not terminate the DuckDB Worker or database.

## Next steps

Read [Guides](./guides.md) for publication and update workflows, then [Concepts](./concepts.md) for generation, snapshot, scanner, and cache semantics.
