---
title: Reference
description: Snapshot schema, JavaScript API, errors, migration notes, and current limitations.
---

# Reference

## Snapshot format

A catalog publication sends one complete snapshot.

```js
{
  format_version: 3,
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
            { uri: 'https://example.test/files/events-r42' },
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

### Snapshot fields

| Field | Meaning |
| --- | --- |
| `format_version` | Snapshot schema version. Use `2` for tables only or `3` for tables and views. |
| `schemas` | Complete set of schemas published by the application. |
| `schemas[].name` | DuckDB schema name. |
| `schemas[].tables` | Tables in the schema. |
| `schemas[].views` | Views in the schema. Available with `format_version: 3`. |
| `tables[].name` | DuckDB table name. |
| `tables[].snapshot` | Table content/schema identity used for scan cache isolation. |
| `tables[].scanner` | Explicit file scanner configuration. |
| `tables[].columns` | Published logical columns in DuckDB order. |
| `tables[].files` | Files forming the table. |
| `views[].name` | DuckDB view name. |
| `views[].query` | One `SELECT` statement defining the view. |

Table and view names share one case-insensitive namespace within a schema. A schema in format 3 may contain tables, views, or both. View columns and types are derived by DuckDB when it binds the query, so view metadata does not include `columns`.

### Columns

Each column has:

```js
{
  name: 'id',
  type: 'BIGINT',
  nullable: false,
}
```

The physical Parquet schema must match the published column count, order, names, and compatible DuckDB types.

### Scanner

The current implementation accepts only:

```js
{
  type: 'parquet',
  options: {},
}
```

Non-empty Parquet options and other scanner types are currently rejected.

### Files

Each file descriptor currently contains a URI:

```js
{ uri: 'https://example.test/data/events.parquet' }
```

The URI identifies location only. File format is declared by `scanner`.

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

Creates a DuckDB connection, loads Parquet and the catalog extension, opens a Worker-side workspace session, publishes the initial snapshot, and attaches the catalog read-only.

`options`:

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `workspaceId` | yes | — | Non-empty workspace/session identifier. |
| `catalogName` | yes | — | Name used by DuckDB when attaching the catalog. |
| `extension` | no | `{ name: 'in_memory_catalog' }` | Extension loading configuration. Use `url` for a directly supplied Wasm extension, or `name` plus `repository` to run `INSTALL ... FROM ...` followed by `LOAD`. |
| `extensionName` | no | — | Legacy alias for a direct `LOAD` name or URL. Do not combine it with `extension`. |
| `ackTimeoutMs` | no | `5000` | Positive safe-integer timeout for Worker acknowledgements. |
| `onRecoveryRequired` | no | — | Callback invoked when cleanup becomes uncertain. |

`extension` examples:

```js
// Directly load an extension asset served by the application.
extension: {
  url: '/extension/in_memory_catalog.duckdb_extension.wasm',
}

// Install and load a binary from a DuckDB extension repository.
extension: {
  name: 'in_memory_catalog',
  repository: 'https://example.test/extensions',
}
```

The extension binary must match the DuckDB-Wasm version selected by the host application and the `wasm_eh` platform. The host application supplies the DuckDB-Wasm dependency and its classic Worker URL. A repository URL is passed to DuckDB as-is; it must implement the repository layout and platform/version resolution expected by the DuckDB-Wasm build in use.

### `createInMemoryCatalogWorker()`

```js
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})
```

Creates the classic Worker wrapper used by DuckDB-Wasm and the catalog. `duckdbWorker` is required and must be the classic Worker belonging to the selected DuckDB-Wasm bundle. The wrapper currently supports `wasm_eh`; `wasm_mvp` and `coi` are not part of the supported API contract. The Worker URL and imported catalog assets must satisfy the application's CSP and browser same-origin/CORS rules.

### `catalog.connection`

The DuckDB connection on which the catalog was attached. Use it for catalog queries.

### `catalog.state`

Controller lifecycle state. The normal terminal state after successful cleanup is `closed`.

### `catalog.publishSnapshot(snapshot)`

Copies the snapshot at call time and publishes it in call order. Successful validation atomically replaces the complete catalog state. The last submitted valid snapshot becomes current. Returns `Promise<void>`.

### `catalog.replaceTable(schemaName, table)`

Replaces the complete definition of an existing table. `table` uses the same format as a table in a snapshot, requiring `name`, `snapshot`, `columns`, `scanner`, and `files`. Schema and table names are matched case-insensitively, preserving their existing spelling. Use `publishSnapshot()` to add, remove, or rename tables.

Input is copied at call time and processed in the same queue as complete publications. Success atomically updates the target table and advances the internal generation. Returns `Promise<void>`.

### `catalog.replaceView(schemaName, view)`

Replaces the complete definition of an existing view in a format 3 snapshot. The view contains exactly `name` and `query`. Schema and view names are matched case-insensitively, preserving their existing spelling. Use `publishSnapshot()` to add, remove, or rename views.

Input is copied at call time and processed in the same queue as complete publications and table replacements. Success atomically updates the target view and advances the internal generation. Returns `Promise<void>`.

### `catalog.diagnostics()`

Returns Worker-side catalog diagnostics after prior queued operations complete.

### `catalog.close()`

Detaches the catalog and drops the workspace. Repeated calls return the same close promise.

## Error behavior

Controller failures throw `InMemoryCatalogControllerError` with a stable `code` string and message.

Important codes include:

| Code | Meaning |
| --- | --- |
| `RC_METADATA_INVALID` | Invalid controller input or catalog metadata. |
| `RC_CATALOG_SCHEMA_NOT_FOUND` | The schema targeted by a table replacement does not exist. |
| `RC_CATALOG_TABLE_NOT_FOUND` | The table targeted by a table replacement does not exist. |
| `RC_CATALOG_VIEW_NOT_FOUND` | The view targeted by a view replacement does not exist. |
| `RC_REMOTE_IO` | Worker communication failed, timed out, or returned an unexpected result. |
| `RC_CATALOG_WORKSPACE_CLOSED` | An operation was attempted after the controller stopped accepting work. |
| `RC_CATALOG_RECOVERY_REQUIRED` | Cleanup failed and the application should recreate the affected runtime. |
| `RC_METADATA_GENERATION_EXHAUSTED` | The private internal generation reached its limit; reopen the workspace. |

Snapshot validation can return additional catalog-specific codes from the Worker/extension. Treat the error code as the machine-readable value and the message as diagnostic text.

DuckDB queries report `RC_CATALOG_VIEW_INVALID` when a view cannot be parsed or bound and `RC_CATALOG_VIEW_CYCLE` when view dependencies are circular. These codes appear in the DuckDB query error message rather than as `InMemoryCatalogControllerError.code`.

## Migration from revision-based publications

Remove `initialRevision` from `initialize(db, worker, options, initialRevision, initialSnapshot)`, pass only the snapshot to `publishSnapshot(snapshot)`, and remove reads of `catalog.currentRevision`. Keep each table's `snapshot` value for bytes, physical schema, and cache identity. The catalog generation is now private bridge state.

## Current limitations

- Experimental public API.
- The host application must provide a DuckDB-Wasm version and a matching `wasm_eh` catalog extension binary.
- The extension build uses the DuckDB commit and Emscripten versions specified in `versions.lock`; these build inputs are separate from the DuckDB-Wasm version selected by the host application.
- Read-only catalog; DuckDB-side catalog mutation is rejected.
- `format_version: 2` supports tables; `format_version: 3` adds views.
- Parquet is the only supported scanner.
- Parquet scanner options must currently be empty.
- The host must provide complete column metadata; schema inference is not performed by the catalog.
- Table `snapshot` values are application-managed and must change when represented bytes or physical schema changes.
- An internal HTTP fragment isolates DuckDB caches, but it cannot make a mutable remote resource version-aware to the server. Concurrent cross-version queries require immutable/versioned remote URLs.

## Development

Requirements:

- Node.js 22
- pnpm 10.17.1
- Git submodules
- Emscripten 3.1.56 for Wasm builds

```sh
git clone --recurse-submodules https://github.com/tokibi/duckdb-wasm-in-memory-catalog.git
cd duckdb-wasm-in-memory-catalog
corepack enable
pnpm install --frozen-lockfile
pnpm test
make build-wasm
```

Build the demo and documentation site with:

```sh
pnpm build:pages
pnpm serve:pages
```

Then open `http://127.0.0.1:4175/`. The documentation is served under `/docs/`.
