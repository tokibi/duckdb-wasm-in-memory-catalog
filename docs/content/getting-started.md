---
title: Getting started
description: Set up DuckDB-Wasm, initialize the in-memory catalog, and run your first query.
---

# Getting started

This guide shows the shortest path from a DuckDB-Wasm database to a queryable in-memory catalog.

## 1. Prepare DuckDB-Wasm

Create the DuckDB Worker and database as usual. The host application owns their lifecycle.

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import { InMemoryCatalogController } from 'duckdb-wasm-in-memory-catalog'

const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
const worker = new Worker(bundle.mainWorker)
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)

await db.instantiate(bundle.mainModule)
```

The catalog controller uses the same Worker as DuckDB-Wasm so the extension can request metadata from the application-side metadata store.

## 2. Define a snapshot

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

## 3. Initialize the catalog

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

## 4. Query it

```js
const result = await catalog.connection.query(`
  SELECT id, category
  FROM app.analytics.events
`)
```

Use `catalog.connection` for queries that need the attached catalog.

## 5. Clean up

```js
await catalog.close()
await db.terminate()
worker.terminate()
```

Closing the controller detaches the catalog and drops its Worker-side snapshot. It does not terminate the DuckDB Worker.

## Next steps

Read [Guides](./guides.md) for publication and update workflows, then [Concepts](./concepts.md) for revision, snapshot, scanner, and cache semantics.
