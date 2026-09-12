---
title: Getting started
description: Set up DuckDB-Wasm, initialize the in-memory catalog, and run your first query.
---

# Getting started

This guide shows the shortest path from a DuckDB-Wasm database to a queryable in-memory catalog.

> [!NOTE]
> The repository is not published as an npm package yet. The examples below use the browser assets produced by this repository. When integrating into another build, keep the same module and Worker boundaries.

## 1. Prepare the browser assets

The catalog needs a custom Worker wrapper in addition to DuckDB-Wasm. That Worker loads the catalog router, metadata store, Worker runtime, and DuckDB's browser Worker into one Dedicated Worker.

Serve these assets from your application:

```text
/in-memory-catalog/in-memory-catalog-controller.mjs
/in-memory-catalog/in-memory-catalog-worker.js
/in-memory-catalog/common-worker-router.js
/in-memory-catalog/in-memory-catalog-metadata-store.js
/in-memory-catalog/in-memory-catalog-worker-runtime.js
/duckdb/duckdb-browser-eh.worker.js
/duckdb/duckdb-eh.wasm
/extension/in_memory_catalog.duckdb_extension.wasm
```

The repository's `scripts/build-pages.mjs` shows one concrete way to assemble them.

## 2. Create DuckDB-Wasm with the catalog Worker

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import { InMemoryCatalogController } from '/in-memory-catalog/in-memory-catalog-controller.mjs'

const worker = new Worker('/in-memory-catalog/in-memory-catalog-worker.js')
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

The same Worker is used by DuckDB-Wasm and the catalog controller. A normal DuckDB browser Worker is not sufficient because it does not handle the catalog's namespaced metadata messages.

`allowUnsignedExtensions` is required when loading the locally built Wasm extension.

## 3. Define a snapshot

A snapshot is the complete catalog state for one revision.

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

The catalog does not infer a scanner from the filename or URI. Every table declares its scanner explicitly.

## 4. Initialize the catalog

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId: crypto.randomUUID(),
    catalogName: 'app',
    extensionName: '/extension/in_memory_catalog.duckdb_extension.wasm',
  },
  1n,
  snapshot,
)
```

Initialization loads Parquet support, loads the in-memory catalog extension, publishes the initial snapshot, and attaches the catalog read-only.

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

Read [Guides](./guides.md) for publication and update workflows, then [Concepts](./concepts.md) for revision, snapshot, scanner, and cache semantics.
