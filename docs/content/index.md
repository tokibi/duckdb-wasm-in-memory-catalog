---
title: DuckDB-Wasm In-Memory Catalog
description: Publish application-owned table metadata as a read-only DuckDB catalog in the browser.
---

# DuckDB-Wasm In-Memory Catalog

Publish application-owned table metadata as a read-only DuckDB catalog in the browser.

The host application owns the schema, table, column, scanner, and file metadata. The catalog publishes that metadata to DuckDB-Wasm without duplicating the application data model in a sequence of `CREATE TABLE` statements.

Use this project when your application already has a declarative dataset model and you want DuckDB-Wasm to query it as a normal catalog.

## What it provides

- A read-only DuckDB catalog backed by application-owned metadata.
- Atomic publication of complete catalog snapshots.
- Explicit table scanners and file URIs.
- Table-level snapshot identities for DuckDB file and Parquet cache isolation.
- A JavaScript controller for lifecycle, publication, diagnostics, and cleanup.

## Start here

1. [Getting started](./getting-started.md) — initialize the runtime and run the first query.
2. [Guides](./guides.md) — publish, update, query, and operate catalogs.
3. [Concepts](./concepts.md) — understand revisions, table snapshots, scanners, cache identity, and runtime ownership.
4. [Reference](./reference.md) — snapshot format, JavaScript API, errors, limitations, and development commands.

The [live demo](../) runs the same catalog implementation in the browser with an editable snapshot and SQL query.

> [!NOTE]
> The project is experimental and the public API is still evolving.
