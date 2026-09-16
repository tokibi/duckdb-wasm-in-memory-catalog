---
title: Concepts
description: Understand complete snapshots, table snapshots, scanners, files, and runtime ownership.
---

# Concepts

## Catalog model

The in-memory catalog is a read-only projection of metadata owned by the host application.

The controller and DuckDB client run on the browser's main thread. The catalog Worker wraps the selected DuckDB-Wasm Worker, routes catalog messages, and keeps catalog metadata in the same Dedicated Worker as the in-memory catalog extension.

![Browser, Worker, and remote-file architecture](./assets/in-memory-catalog-worker-architecture-overview.svg)

Catalog updates use a dedicated `MessagePort`; metadata is copied at the structured-clone boundary and the port is transferred when the session opens. Queries use the normal Worker message path; query results use transferred `ArrayBuffer`s. The extension looks up current catalog metadata synchronously inside the Worker, while DuckDB-Wasm initiates HTTP(S) reads for the files.

The application remains authoritative. DuckDB sees schemas, tables, views, and columns as normal catalog objects, but it does not own their definition.

## Catalog updates

`publishSnapshot()` submits the complete catalog state. `replaceTable()` and `replaceView()` submit one existing relation's complete definition. The controller copies the input at call time and sends publications to the Worker in call order. The Worker validates the submitted metadata before atomically updating the current state. Failed validation leaves the current state unchanged.

Successful operations update the catalog in call order. A complete publication replaces the entire state; a relation replacement preserves other tables and views. If asynchronous application work produces snapshots out of order, discard stale results before publishing them.

The Worker automatically maintains an internal counter for DuckDB metadata invalidation and generation checks during reads. Every successful publication advances it, including identical content; failed validation does not. Applications do not manage this counter.

## Views

`format_version: 3` can publish views alongside tables. A view contains a name and one `SELECT` query; DuckDB binds that query and derives its columns and types when the view is used. Views can refer to catalog tables and other views. Invalid queries and circular view dependencies produce query errors without changing the published snapshot.

The internal catalog generation also invalidates bound view entries. After `publishSnapshot()`, `replaceTable()`, or `replaceView()` succeeds, the next query binds affected views from the current definitions.

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

The current implementation supports Parquet, CSV, JSON, and XLSX. See [Scanners](./scanners.md) for scanner configuration and the complete list of accepted options.

```js
scanner: {
  type: 'parquet',
  options: {},
}

```

The Parquet scanner validates the physical schema against the published column count, order, names, and types. The CSV scanner uses the published columns as its read schema and validates the CSV header, column count, and values against that schema. See [Scanners](./scanners.md) for CSV defaults and options.

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

DuckDB-side catalog mutation is intentionally unsupported. Allowing DuckDB-side DDL to diverge from the application's model would create two competing sources of truth.

When the application changes a dataset or view, update the application state and submit it with `publishSnapshot()`, `replaceTable()`, or `replaceView()`.
