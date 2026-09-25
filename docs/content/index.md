---
title: DuckDB-Wasm In-Memory Catalog
description: Publish application-owned table metadata as a read-only DuckDB catalog in the browser.
---

# DuckDB-Wasm In-Memory Catalog

Publish application-owned table metadata as a read-only DuckDB catalog in the browser.

The host application provides schema, table, column, scanner, and file metadata as a declarative JSON snapshot. DuckDB-Wasm queries this state as a standard catalog without requiring manual DDL synchronization or duplicate `CREATE TABLE` definitions.

---

## The Problem & Solution (Before / After)

When building data-intensive web apps with DuckDB-Wasm, querying remote files typically requires running imperative DDL statements or repeatedly using table functions (`read_parquet`, `read_csv`).

| Aspect | Traditional Approach (Before) | In-Memory Catalog (After) |
|---|---|---|
| **Catalog Definition** | Imperative DDL (`CREATE TABLE`, `CREATE VIEW`) | Pure JSON **declarative snapshots** |
| **Source of Truth** | Split between application state and DuckDB engine | Application remains the single source of truth |
| **Data Updates** | Race conditions with concurrent `DROP` / `CREATE` | Atomic whole-catalog replacement or table hot-swaps |
| **HTTP Caching** | Stale caches when files update at the same URL | Reliable cache isolation via fragment IDs (`#duckdb-snapshot=...`) |
| **SQL Queries** | Long parameterized URLs inside `read_parquet(...)` | Clean SQL references (`SELECT * FROM app.analytics.events`) |

---

## Relationship with Lakehouse Formats

If your infrastructure already supports Lakehouse table formats such as Apache Iceberg or Delta Lake, adopting those formats is recommended for managing table metadata and transactions at the storage layer.

The goal of this library is different: it allows lightweight application-owned data structures, such as schema definitions, column metadata, and file URL lists, to serve directly as table and view definitions for DuckDB-Wasm, without requiring dedicated table formats or storage-level metadata infrastructure.

---

## Key Features

- ⚡ **Declarative Catalog Publishing**: Expose application-managed metadata as a DuckDB catalog without manual DDL management.
- 📦 **Multi-Format Scanners**: Native support for **Parquet**, **CSV**, **JSON**, and **XLSX** files.
- 🔄 **Atomic Snapshots & Table Hot-Swapping**: Publish whole-catalog snapshots (`publishSnapshot`) or update individual tables (`replaceTable`) atomically without race conditions.
- 🛡️ **Cache Isolation**: Attaches internal snapshot identifiers (`#duckdb-snapshot=...`) to remote URIs so DuckDB's HTTP/Parquet cache updates reliably without modifying backend URLs.
- 🔍 **SQL Views Support**: Publish declarative SQL views alongside tables with automatic invalidation and re-binding on updates.
- 🧵 **Worker-Thread Isolation**: Catalog state validation and metadata resolution run in a Dedicated Worker, keeping the main UI thread responsive.

---

## Architecture Overview

![Browser, Worker, and remote file architecture](./assets/in-memory-catalog-worker-architecture-overview.svg)

1. **Host Application**: Manages metadata state and passes whole-catalog snapshots or table replacements to `InMemoryCatalogController`.
2. **Dedicated Web Worker**: Runs DuckDB-Wasm alongside the in-memory catalog metadata store.
3. **`in_memory_catalog` Wasm Extension**: Intercepts DuckDB table binding and queries the worker's store synchronously for schema and scan URIs.
4. **DuckDB-Wasm Engine**: Executes SQL queries by issuing HTTP Range requests directly to remote storage.

---

## Documentation Roadmap

- [**Getting Started**](./getting-started.md) — Step-by-step setup guide, worker runtime, and complete minimal example.
- [**Guides**](./guides.md) — Practical recipes for publishing, table hot-swapping, SQL views, and remote file handling.
- [**Concepts**](./concepts.md) — Architecture, cache isolation mechanics, separation of concerns, and read-only principles.
- [**Scanners**](./scanners.md) — Full configuration and options reference for Parquet, CSV, JSON, and XLSX.
- [**Reference**](./reference.md) — Complete snapshot schema specification, JavaScript API, error codes, and limitations.

The [**live demo**](../) runs this catalog implementation directly in the browser with an interactive SQL editor.

> [!NOTE]
> The project is experimental and the public API is actively evolving.
