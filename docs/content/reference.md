---
title: Reference
description: Complete snapshot schema specification, JavaScript API reference, error codes, and limitations.
---

# Reference

## Snapshot Format

Catalog publications require a complete snapshot object describing schemas, tables, and views:

```js
{
  format_version: 1,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'events-r42',
          scanner: {
            type: 'parquet',
            options: {},
          },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: true },
          ],
          files: [
            'https://example.test/files/events-r42.parquet',
          ],
        },
      ],
      views: [
        {
          name: 'recent_events',
          query: "SELECT * FROM events WHERE occurred_at >= current_date - INTERVAL '7 days'",
        },
      ],
    },
  ],
}
```

### Snapshot Fields Reference

| Field | Type | Description |
|---|---|---|
| `format_version` | `number` | Snapshot schema version (currently `1`). |
| `schemas` | `Array` | List of schemas published by the host application. |
| `schemas[].name` | `string` | DuckDB schema name. |
| `schemas[].tables` | `Array` | Tables contained in the schema. |
| `schemas[].views` | `Array` | Views contained in the schema. |
| `tables[].name` | `string` | DuckDB table name. |
| `tables[].snapshot` | `string` | Cache identity key for scan cache isolation. |
| `tables[].scanner` | `object` | Explicit file scanner configuration (`type`, `options`). |
| `tables[].columns` | `Array` | Ordered column definitions. |
| `tables[].files` | `string[]` | Array of file URI strings. |
| `views[].name` | `string` | DuckDB view name. |
| `views[].query` | `string` | Single `SELECT` SQL statement defining the view. |

> [!NOTE]
> Table and view names within the same schema share a case-insensitive namespace. Views do not include `columns` metadata because DuckDB infers them at query binding time.

### Column Specification (`columns`)

```js
{
  name: 'id',
  type: 'BIGINT',
  nullable: false,
}
```

- **Scalar Types**: `BOOLEAN`, `TINYINT`, `SMALLINT`, `INTEGER`, `BIGINT`, `HUGEINT`, `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`, `FLOAT`, `DOUBLE`, `DECIMAL(p,s)`, `VARCHAR`, `BLOB`, `DATE`, `TIME`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, `INTERVAL`, etc.
- **Nested Types**: `JSON`, `STRUCT(...)`, `LIST(...)` or `type[]`. Nesting up to 32 levels.

### Scanner Specification (`scanner`)

```js
{
  type: 'parquet', // 'parquet' | 'csv' | 'json' | 'xlsx'
  options: {},
}
```

See [Scanners Reference](./scanners.md) for full scanner options.

---

## JavaScript API

### `InMemoryCatalogController.initialize()`

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  options,
  initialSnapshot,
)
```

Creates a DuckDB connection, loads extensions, sends the initial snapshot to the worker, and attaches the catalog as a read-only catalog in DuckDB.

#### `options` Parameter

| Property | Required | Default | Description |
|---|---|---|---|
| `workspaceId` | Optional | `crypto.randomUUID()` | Unique workspace/session identifier. |
| `catalogName` | **Required** | — | Catalog name attached in DuckDB. |
| `extension` | Optional | `{ name: 'in_memory_catalog' }` | Extension loading options. Specify `url` for direct Wasm loading or `name` and `repository` for install-and-load. |
| `ackTimeoutMs` | Optional | `5000` | Worker response timeout in milliseconds. |
| `onRecoveryRequired` | Optional | — | Callback invoked when runtime cleanup fails. |

---

### `createInMemoryCatalogWorker()`

```js
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})
```

Creates the combined Dedicated Worker wrapping DuckDB-Wasm and the catalog metadata store.
- `duckdbWorker`: URL to the classic DuckDB-Wasm worker script.

---

### `catalog.connection`

The active DuckDB connection instance where the catalog is attached. Execute all queries through this connection.

---

### `catalog.publishSnapshot(snapshot)`

Atomically replaces the entire catalog state with a new snapshot:

```js
await catalog.publishSnapshot(nextSnapshot)
```

---

### `catalog.replaceTable(schemaName, table)`

Atomically replaces the definition of an existing table:

```js
await catalog.replaceTable('analytics', {
  name: 'events',
  snapshot: 'v2',
  scanner: { type: 'parquet', options: {} },
  columns: [...],
  files: [...],
})
```

---

### `catalog.replaceView(schemaName, view)`

Atomically replaces the query definition of an existing view:

```js
await catalog.replaceView('analytics', {
  name: 'recent_events',
  query: 'SELECT * FROM events WHERE is_active = true',
})
```

---

### `catalog.diagnostics()`

Returns diagnostic information from the Dedicated Worker, including session status, table counts, and generation counters.

---

### `catalog.close()`

Detaches the catalog from DuckDB and frees worker workspace resources.

---

## Error Handling

Errors from the controller are instances of `InMemoryCatalogControllerError`:

| Error Code | Description |
|---|---|
| `RC_METADATA_INVALID` | Invalid snapshot or table schema metadata. |
| `RC_CATALOG_SCHEMA_NOT_FOUND` | Target schema not found during single relation update. |
| `RC_CATALOG_TABLE_NOT_FOUND` | Target table not found during single table update. |
| `RC_CATALOG_VIEW_NOT_FOUND` | Target view not found during single view update. |
| `RC_REMOTE_IO` | Worker communication failure, timeout, or unexpected response. |
| `RC_CATALOG_WORKSPACE_CLOSED` | Invoked operation on an already closed controller. |
| `RC_CATALOG_RECOVERY_REQUIRED` | Runtime entered an unrecoverable state requiring restart. |
| `RC_METADATA_GENERATION_EXHAUSTED` | Internal generation counter overflow (recreate workspace). |

---

## Limitations

- **Experimental API**: The public API is evolving.
- **Read-Only**: Catalog mutations (`INSERT`, `CREATE TABLE`) via DuckDB are rejected.
- **Explicit Schemas**: The host application must explicitly specify `columns` (no schema inference).
- **Cache Isolation**: Fragment IDs (`#duckdb-snapshot=...`) isolate DuckDB's client-side caches; they do not provide server-side versioning for mutable resources.
- **XLSX Format**: Supports one file per table and requires `.xlsx` format.
