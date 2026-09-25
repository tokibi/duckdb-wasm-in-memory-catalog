---
title: Concepts
description: Core concepts of In-Memory Catalog including snapshot lifecycle, cache isolation, separation of concerns, and runtime ownership.
---

# Concepts

This document explains the core architectural principles and internal mechanics of the DuckDB-Wasm In-Memory Catalog.

---

## 1. Catalog Model

The in-memory catalog enables **publishing application-owned metadata directly to DuckDB as a standard, read-only catalog**.

![Browser, Worker, and remote file architecture](./assets/in-memory-catalog-worker-architecture-overview.svg)

### Thread Separation & Synchronous Resolution
- **Main Thread**: Runs the host application UI, `InMemoryCatalogController`, and DuckDB client.
- **Dedicated Worker**: Hosts both DuckDB-Wasm and the catalog metadata store within the same Web Worker context.
- **Synchronous Metadata Lookup**: When DuckDB's C++ engine binds tables, it queries the worker's metadata store synchronously via the C++ Wasm extension. This eliminates asynchronous message passing overhead and avoids blocking DuckDB's query scheduler.
- **Single Source of Truth**: The host application retains sole authority over schema and table definitions. DuckDB consumes this metadata as an immutable catalog view.

---

## 2. Catalog Lifecycle & Updates

The controller offers two primary update mechanisms:

| Method | Target | Use Case |
|---|---|---|
| `publishSnapshot()` | Entire Catalog | Full schema overhaul, replacing all tables, initial setup |
| `replaceTable()` / `replaceView()` | Single Table / View | Updating file URLs or schema for one table while preserving others |

### Atomicity & Validation
1. **Serialized Queue**: All controller operations are queued and delivered to the Dedicated Worker in calling order.
2. **Strict Validation**: The worker validates schema constraints, column types, and scanner configurations before committing changes.
3. **Atomic Commit**: If validation passes, the catalog state is swapped atomically. If validation fails, changes are rejected and existing state remains untouched.
4. **Internal Generation Tracking**: Each successful update increments an internal generation counter, automatically invalidating stale DuckDB table and view bindings.

---

## 3. Separation of Concerns (Table Definition)

Every table definition separates three distinct concerns:

```text
1. columns   (How DuckDB views the table)   -> Column names, types, and nullability
2. scanner   (How files are decoded)        -> Parquet / CSV / JSON / XLSX and scanner options
3. files     (Where data lives)             -> Array of remote or local URIs
```

### Explicit Scanners
Scanners are never inferred from filenames or extensions (`.parquet`, `.csv`). Explicitly declaring `scanner: { type: '...' }` ensures deterministic parsing even when URLs lack standard file extensions.

---

## 4. Table Snapshots & Cache Isolation

### The Caching Problem
DuckDB-Wasm aggressively caches HTTP Range requests and Parquet metadata. When an underlying remote file changes at the same URL, DuckDB can continue returning stale cached data.

### URL Fragment Isolation
In-Memory Catalog attaches each table's `snapshot` identifier as an internal URL fragment:

```text
Application-provided URI:
  https://example.com/data/sales.parquet

DuckDB-Wasm Internal Scan URI:
  https://example.com/data/sales.parquet#duckdb-snapshot=sales-20260925
```

- **Zero Network Impact**: Browser HTTP implementations never send URL fragments (`#...`) in HTTP requests. CDNs and web servers see only the clean base URL.
- **DuckDB Cache Freshness**: Because DuckDB keys its internal caches on the full URI (including fragments), updating `snapshot` immediately creates a fresh cache key and invalidates stale data.
- **Selective Retention**: Tables whose `snapshot` has not changed continue utilizing DuckDB's cache.

---

## 5. View Binding & Revalidation

SQL views (`views`) can be published alongside tables:

- **Deferred Binding**: View columns and data types are not declared in the snapshot. DuckDB resolves and binds them dynamically during query compilation.
- **Automatic Invalidation**: Whenever referenced tables are updated via `replaceTable` or `publishSnapshot`, the incremented catalog generation forces DuckDB to re-bind the view on the next query.

---

## 6. Why Read-Only?

In-Memory Catalog intentionally rejects DDL statements (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) and DML mutations (`INSERT`, `UPDATE`).

Allowing DuckDB to mutate catalog state would create **two conflicting sources of truth**: the application state and the DuckDB internal catalog. By enforcing a strict **unidirectional data flow** (Application State → Snapshot → In-Memory Catalog → DuckDB Queries), the system eliminates state drift and race conditions.

---

## 7. Runtime Ownership

- **Host Application owns**: Dedicated Worker lifecycle, DuckDB instance, and database lifecycle.
- **Controller owns**: Catalog connection, worker workspace session, and the attached catalog.

Calling `catalog.close()` detaches the catalog and drops the worker workspace, but leaves the DuckDB database and worker running so they can be reused.

---

## 8. Relationship with Lakehouse Formats

If your infrastructure already supports Lakehouse table formats such as Apache Iceberg or Delta Lake, adopting those formats is recommended for managing table metadata and transactions at the storage layer.

The goal of this library is different: it allows lightweight application-owned data structures, such as schema definitions, column metadata, and file URL lists, to serve directly as table and view definitions for DuckDB-Wasm, without requiring dedicated table formats or storage-level metadata infrastructure.

