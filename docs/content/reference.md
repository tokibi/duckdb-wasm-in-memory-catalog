---
title: Reference
description: Snapshot schema, JavaScript API, errors, and current limitations.
---

# Reference

## Snapshot format

A catalog publication sends a `bigint` revision and one complete snapshot.

```js
{
  format_version: 2,
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
    },
  ],
}
```

### Snapshot fields

| Field | Meaning |
| --- | --- |
| `format_version` | Snapshot schema version. The current format is `2`. |
| `schemas` | Complete set of schemas published by the application. |
| `schemas[].name` | DuckDB schema name. |
| `schemas[].tables` | Tables in the schema. |
| `tables[].name` | DuckDB table name. |
| `tables[].snapshot` | Table content/schema identity used for scan cache isolation. |
| `tables[].scanner` | Explicit file scanner configuration. |
| `tables[].columns` | Published logical columns in DuckDB order. |
| `tables[].files` | Files forming the table. |

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
  initialRevision,
  initialSnapshot,
)
```

Creates a DuckDB connection, loads Parquet and the catalog extension, opens a Worker-side workspace session, publishes the initial snapshot, and attaches the catalog read-only.

`options`:

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `workspaceId` | yes | — | Non-empty workspace/session identifier. |
| `catalogName` | yes | — | Name used by DuckDB when attaching the catalog. |
| `extensionName` | no | `in_memory_catalog` | Extension name or URL passed to `LOAD`. |
| `ackTimeoutMs` | no | `5000` | Positive safe-integer timeout for Worker acknowledgements. |
| `onRecoveryRequired` | no | — | Callback invoked when cleanup becomes uncertain. |

`initialRevision` must be a `bigint` in the unsigned 64-bit range.

### `catalog.connection`

The DuckDB connection on which the catalog was attached. Use it for catalog queries.

### `catalog.currentRevision`

The most recently published catalog revision after a successful publication.

### `catalog.state`

Controller lifecycle state. The normal terminal state after successful cleanup is `closed`.

### `catalog.publishSnapshot(revision, snapshot)`

Publishes a complete replacement snapshot. Operations are serialized in call order.

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
| `RC_REMOTE_IO` | Worker communication failed, timed out, or returned an unexpected result. |
| `RC_CATALOG_WORKSPACE_CLOSED` | An operation was attempted after the controller stopped accepting work. |
| `RC_CATALOG_RECOVERY_REQUIRED` | Cleanup failed and the application should recreate the affected runtime. |

Snapshot validation can return additional catalog-specific codes from the Worker/extension. Treat the error code as the machine-readable value and the message as diagnostic text.

## Current limitations

- Experimental public API.
- Read-only catalog; DuckDB-side catalog mutation is rejected.
- `format_version: 2` only.
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
