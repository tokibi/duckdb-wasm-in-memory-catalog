---
title: Concepts
description: Understand complete snapshots, table snapshots, scanners, files, and runtime ownership.
---

# Concepts

## Catalog model

The in-memory catalog is a read-only projection of metadata owned by the host application.

```text
application state
      │
      │ complete snapshot
      ▼
Catalog controller
      │
      │ MessageChannel
      ▼
Dedicated Worker metadata store
      │
      │ table lookup
      ▼
in_memory_catalog extension
      │
      ▼
DuckDB-Wasm
```

The application remains authoritative. DuckDB sees schemas, tables, and columns as normal catalog objects, but it does not own their definition.

## Complete snapshots

Each publication contains the complete catalog state. The controller copies the input at call time and sends publications to the Worker in call order. The Worker validates the entire snapshot before atomically replacing the current state. Failed validation leaves the current state unchanged.

The last submitted valid snapshot becomes current. If asynchronous application work produces snapshots out of order, discard stale results before publishing them.

The Worker automatically maintains an internal counter for DuckDB metadata invalidation and generation checks during reads. Every successful publication advances it, including identical content; failed validation does not. Applications do not manage this counter.

## Table snapshot

The table `snapshot` identifies the bytes and physical schema represented by that table's files. Change it when those bytes or that physical schema changes.

Keeping a table's `snapshot` unchanged across unrelated catalog updates preserves its DuckDB file and Parquet cache identity.

## Scanners and files

A table separates three concerns:

```text
columns      how the table appears to DuckDB
scanner      how the files are interpreted
files[].uri  where the files are located
```

The scanner is table-level because all files forming one table are expected to share the same read configuration.

`format_version: 2` requires an explicit scanner. The catalog never chooses one from a filename, extension, or URI shape.

The current implementation supports:

```js
scanner: {
  type: 'parquet',
  options: {},
}
```

The Parquet scanner validates the physical schema against the published column count, order, names, and types.

## Scan URI and cache identity

For HTTP(S) files, the extension derives an internal scan URI by adding the table snapshot as a fragment parameter:

```text
metadata URI:
  https://example.test/files/events

DuckDB scan URI:
  https://example.test/files/events#duckdb-snapshot=events-r42
```

Fragments stay local to the browser and DuckDB; they are not sent in HTTP requests. This changes DuckDB's cache key without changing the remote request URL.

For non-HTTP(S) URIs, the URI is passed through unchanged.

## Runtime ownership

The host owns the DuckDB Worker and database lifecycle. The controller owns only its catalog connection, Worker-side workspace session, and attached catalog.

`close()` waits for queued publication work, detaches the catalog, asks the Worker to drop the workspace, closes the session and connection, and reports when recovery is required. It does not terminate the Worker or database.

## Read-only by design

Catalog mutation is intentionally unsupported. Allowing DuckDB-side DDL to diverge from the application's model would create two competing sources of truth.

When the application changes a dataset, update the application state and publish a new complete catalog snapshot instead.
