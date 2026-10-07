---
title: Guides
description: Practical recipes for publishing, updating, querying, and operating in-memory catalogs.
---

# Guides

This guide covers real-world recipes and patterns for integrating and operating In-Memory Catalog in frontend applications.

---

## Recipe 1: Publish a Catalog from Application State

Treat your application's data model (React state, Pinia/Redux stores, or API metadata) as the single source of truth, and transform it into a declarative snapshot:

```js
// Application dataset state
const datasets = [
  {
    id: 'users',
    version: '2026-09-01',
    format: 'parquet',
    fields: [
      { name: 'id', type: 'BIGINT', nullable: false },
      { name: 'email', type: 'VARCHAR', nullable: true },
    ],
    url: 'https://cdn.example.com/users.parquet',
  },
]

// Convert to catalog snapshot format
function createSnapshot(datasetList) {
  return {
    format_version: 1,
    schemas: [
      {
        name: 'main',
        tables: datasetList.map((ds) => ({
          name: ds.id,
          snapshot: ds.version, // Bumping version invalidates DuckDB cache
          scanner: { type: ds.format, options: {} },
          columns: ds.fields,
          files: [ds.url],
        })),
      },
    ],
  }
}

// Publish to catalog
await catalog.update((update) => update.publishSnapshot(createSnapshot(datasets)))
```

This eliminates procedural DDL statements (`CREATE TABLE`, `ALTER TABLE`) and ensures application state is directly reflected in DuckDB.

---

## Recipe 2: Atomically Update the Whole Catalog (`publishSnapshot`)

To add/remove schemas or update all tables simultaneously, publish a new complete snapshot:

```js
const nextSnapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'main',
      tables: [/* new table definitions */],
      views: [/* new view definitions */],
    },
  ],
}

await catalog.update((update) => update.publishSnapshot(nextSnapshot))
```

- **Atomicity**: The controller queues updates in order. The Dedicated Worker validates the snapshot before replacing state atomically. Invalid metadata is not applied, but the failed update stops further queries until the Worker is recreated.
- **Async Handling**: If multiple async tasks produce snapshots, discard outdated snapshots before calling `publishSnapshot`.

---

## Why Updates Use a Callback

One SQL query can read a file more than once. For example, a remote Parquet scan can first read the footer metadata to locate columns and row groups, then fetch the relevant row data with additional Range requests.

If a file is overwritten between those reads, DuckDB may combine metadata from the old file with row data from the new file. Offsets or lengths may no longer match, causing a read error or inconsistent results. Publishing a new catalog `snapshot` only changes the cache identity for subsequent scans; it does not make the requests of an in-progress scan refer to one file version.

`catalog.update(callback)` protects the entire update interval, not just the metadata publication:

1. Wait for ordinary queries already running in the same Worker to finish, then block new query starts.
2. Run the callback, which overwrites the file and publishes its new catalog metadata.
3. Resume queued queries after the callback and all submitted metadata operations complete. If the callback or publication fails, keep queries blocked for recovery.

The function passed to `update` is a **callback**. It may also be a closure that captures application variables; the API uses its invocation and completion to define the protected interval. Locking only `replaceTable` would leave the preceding file overwrite unprotected, so even metadata-only updates use the same callback API. Initial publication by `initialize` uses this path too.

## Overwriting a File While Queries May Be Running

Read through the normal DuckDB connection, such as `catalog.connection.query(sql)`. Enclose both the remote write and metadata update in one exclusive callback:

```js
await catalog.update(async (update) => {
  await storage.overwrite(fileId, parquetBytes)
  await update.replaceTable('main', {
    ...currentTable,
    snapshot: nextSnapshotId,
  })
})
```

Existing ordinary queries finish before the write starts; subsequent queries on any connection in the same Worker wait until the callback and submitted publications finish. Use only the supplied `update` methods for catalog operations inside the callback, and do not await DuckDB queries there. If no update is needed, the callback may return without publishing metadata. When changing a file, update the affected table's `snapshot` as shown above. An active stream delays the update until it finishes or is cancelled; existing streams can continue reading while the update waits. New stream starts during an update reject. Acquisition waiting is limited by `ackTimeoutMs` (default 5000 ms). On timeout, the callback is not invoked and the pending acquisition is cancelled; the stream itself is left running. A callback or publication failure blocks DuckDB work until you repair the files and metadata and recreate the Worker and controllers. Other Workers, tabs, and external writers remain outside this coordination. See the [API reference](./reference.md#catalogupdatecallback) for scope and recovery details.

## Recipe 3: Hot-Swap a Single Table (`replaceTable`)

To update a single table's files or schema without disturbing other tables or re-validating the entire catalog:

```js
// Update only the 'events' table in the 'main' schema
await catalog.update((update) => update.replaceTable('main', {
  name: 'events',
  snapshot: 'events-v2', // Invalidates DuckDB cache for this table only
  scanner: { type: 'parquet', options: {} },
  columns: [
    { name: 'id', type: 'BIGINT', nullable: false },
    { name: 'payload', type: 'JSON', nullable: true },
  ],
  files: [
    'https://cdn.example.com/events-part1.parquet',
    'https://cdn.example.com/events-part2.parquet',
  ],
}))
```

- If the table or schema does not exist, an error is thrown.
- Other tables and their cached query results remain unaffected.

---

## Recipe 4: Publish and Hot-Swap SQL Views (`replaceView`)

Pre-define SQL views for common joins, aggregations, or filters alongside your tables:

```js
// 1. Register views in snapshot
const snapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'main',
      tables: [/* table definitions */],
      views: [
        {
          name: 'active_users',
          query: 'SELECT id, email FROM users WHERE is_active = true',
        },
      ],
    },
  ],
}
await catalog.update((update) => update.publishSnapshot(snapshot))

// 2. Hot-swap the view query definition
await catalog.update((update) => update.replaceView('main', {
  name: 'active_users',
  query: 'SELECT id, email, created_at FROM users WHERE is_active = true AND verified = true',
}))
```

- View columns and types are dynamically inferred by DuckDB when the query is bound (no `columns` field required).
- Views are automatically re-bound on subsequent queries whenever referenced tables are updated.

---

## Recipe 5: Querying the Catalog

Query tables and views using 3-part or 2-part identifiers:

```sql
SELECT email, count(*)
FROM app.main.active_users
GROUP BY email;
```

Use `USE` to set the default catalog and schema for simpler queries:

```js
await catalog.connection.query('USE app.main')

const res = await catalog.connection.query(`
  SELECT * FROM active_users LIMIT 10
`)
```

> [!WARNING]
> Catalogs are read-only. DDL (`DROP`, `ALTER`) and DML (`INSERT`, `UPDATE`) statements will fail. Always mutate state via `publishSnapshot` or `replaceTable`.

---

## Recipe 6: Remote File Access & Cache Isolation

When accessing remote HTTP(S) files, configure DuckDB-Wasm's filesystem appropriately:

```js
await db.open({
  allowUnsignedExtensions: true,
  maximumThreads: 1,
  filesystem: {
    reliableHeadRequests: false, // Prefer GET Range over HEAD
    allowFullHTTPReads: true,    // Fallback if server lacks Range support
    forceFullHTTPReads: false,
  },
})
```

### Cache Isolation via URI Fragments
To prevent DuckDB-Wasm from reading stale cached data after files update, the extension generates internal scan URIs with fragments:

- Published URI: `https://example.com/events.parquet`
- Internal Scan URI: `https://example.com/events.parquet#duckdb-snapshot=events-v2`

The fragment (`#...`) is stripped before HTTP requests reach the server, so CDN and server URLs remain unchanged while DuckDB cache keys are isolated.

---

## Recipe 7: Inspecting Diagnostics

Use `catalog.diagnostics()` to inspect internal state and troubleshoot issues:

```js
const info = await catalog.diagnostics()
console.log('Worker Catalog Diagnostics:', info)
```

Returns worker session state, active schemas/tables, and internal generation counters.

---

## Recipe 8: Recovery Callback & Lifecycle Cleanup

### Recovery Handler (`onRecoveryRequired`)
Handle communication failures or corrupted worker states cleanly:

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    catalogName: 'app',
    extension: { url: '/extension/in_memory_catalog.duckdb_extension.wasm' },
    onRecoveryRequired({ workspaceId }) {
      console.error('Catalog runtime must be recreated:', workspaceId)
    },
  },
  snapshot,
)
```

### Clean Teardown
When unmounting components or terminating the session:

```js
// Awaits queued operations, detaches catalog, releases worker resources
await catalog.close()
```
