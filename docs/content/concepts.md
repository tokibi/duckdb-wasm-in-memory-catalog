---
title: Concepts
description: Understand the catalog model, revisions, table snapshots, scanners, files, and runtime ownership.
---

# Concepts

## Catalog model

The in-memory catalog is a read-only projection of metadata owned by the host application.

```text
application state
      │
      │ complete snapshot + revision
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

Each publication contains a complete snapshot rather than a patch. This makes synchronization deterministic: after a successful publication, the Worker-side metadata store represents exactly that revision.

A newer revision atomically replaces the previous snapshot. Failed validation does not partially update the catalog.

## Catalog revision vs. table snapshot

These two values solve different problems.

The **catalog revision** orders complete metadata publications. It must increase when publishing a new catalog state, even if a change affects only metadata unrelated to a particular table.

The **table `snapshot`** identifies the bytes and physical schema represented by that table's files. Change it when those bytes or that physical schema changes.

Keeping these identities separate prevents an unrelated catalog update from invalidating DuckDB's file and Parquet caches for every table.

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
