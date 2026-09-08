# DuckDB-Wasm In-Memory Catalog

Publish application-owned table metadata as a read-only DuckDB catalog in the browser.

This repository contains the standalone **In-Memory Catalog** component extracted from `tokibi/duckdb-wasm-remote-catalog`.

## What it does

The host application publishes an immutable catalog snapshot containing schemas, tables, columns, and opaque file URIs. The component exposes that snapshot to DuckDB-Wasm as a read-only attached catalog.

File URIs are intentionally opaque to the Catalog. Authentication, provider APIs, and remote-file transport are outside this component.

## Components

- DuckDB loadable extension: `in_memory_catalog`
- JavaScript controller and metadata store
- Dedicated Worker runtime

## Status

Experimental. The public API is still evolving.

## License

MIT
