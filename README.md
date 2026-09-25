# DuckDB-Wasm In-Memory Catalog

> Publish application-owned table metadata as a read-only DuckDB catalog in the browser.

[**Live Demo**](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/) · [**Documentation**](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/) · [**日本語ドキュメント**](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/) · [MIT License](LICENSE)

---

## Why DuckDB-Wasm In-Memory Catalog?

When building data-intensive browser applications with [DuckDB-Wasm](https://github.com/duckdb/duckdb-wasm), querying remote files typically requires running imperative DDL statements (`CREATE TABLE`, `CREATE VIEW`) or repeatedly writing table-function queries (such as `read_parquet` or `read_csv`).

If your application already manages dataset definitions, schemas, and file locations in state, synchronizing this state through procedural SQL introduces friction:
- **Duplicate State & Fragile DDL**: Your application must generate and run `CREATE` / `ALTER` / `DROP` statements to stay in sync with application state.
- **Cache Invalidation Issues**: DuckDB-Wasm caches HTTP file ranges. When underlying data or schema updates, stale caches can cause incorrect query results.
- **Race Conditions**: Parallel or asynchronous updates in the UI can result in inconsistent catalog states.

**DuckDB-Wasm In-Memory Catalog** solves this by connecting your application's declarative state directly to DuckDB-Wasm as a standard read-only catalog:
- Pass a JSON **snapshot** of schemas, tables, and views to the controller.
- DuckDB queries your tables as standard relations: `SELECT * FROM my_catalog.analytics.events`.
- Updates are validated, serialized, and atomically applied inside a Dedicated Web Worker.

If your infrastructure already manages tables with Lakehouse formats such as Apache Iceberg or Delta Lake, those formats remain recommended for storage-level metadata and transactions. In-Memory Catalog is designed for cases where you want lightweight, application-owned data structures to serve directly as DuckDB-Wasm tables and views without requiring dedicated table formats or storage infrastructure.

---

## Key Features

- ⚡ **Declarative Catalog Publishing**: Expose application-managed metadata as a DuckDB catalog without manual DDL management.
- 📦 **Multi-Format Scanners**: Native support for **Parquet**, **CSV**, **JSON**, and **XLSX** files.
- 🔄 **Atomic Snapshots & Table Hot-Swapping**: Publish whole-catalog snapshots (`publishSnapshot`) or update individual tables (`replaceTable`) atomically without race conditions.
- 🛡️ **Cache Isolation**: Attaches internal snapshot identifiers (`#duckdb-snapshot=...`) to remote URIs so DuckDB's HTTP/Parquet cache updates without modifying backend URLs.
- 🔍 **SQL Views Support**: Publish declarative SQL views alongside tables with automatic invalidation and re-binding on updates.
- 🧵 **Worker-Thread Isolation**: Catalog state validation and metadata resolution run in a Dedicated Worker, keeping the main UI thread responsive.

---

## Architecture Overview

```mermaid
flowchart LR
  subgraph Main[Main UI Thread]
    App[Host Application State]
    Controller[Catalog Controller]
  end
  subgraph Dedicated[Dedicated Web Worker]
    DuckDB[DuckDB-Wasm Engine]
    Extension[in_memory_catalog Extension]
    Store[Catalog Metadata Store]
  end
  Remote[(Remote Files<br/>Parquet / CSV / JSON / XLSX)]

  App -->|publishSnapshot() / replaceTable()| Controller
  Controller -->|MessageChannel / Structured Clone| Store
  DuckDB --> Extension
  Extension -->|lookup table & columns| Store
  Store -->|columns, types & scan URIs| Extension
  DuckDB -.->|HTTP range requests| Remote
```

1. **Host Application** manages metadata and sends a complete catalog snapshot or table update to `InMemoryCatalogController`.
2. **Dedicated Worker** runs DuckDB-Wasm alongside the catalog metadata store. Messages are serialized via `MessageChannel`.
3. **`in_memory_catalog` Wasm Extension** intercepts table lookups from DuckDB queries and reads metadata synchronously inside the worker.
4. **DuckDB-Wasm** fetches file data directly via HTTP(S) range requests using schema and options provided by the extension.

---

## Quickstart

### 1. Set Up the Dedicated Worker

The catalog requires a custom worker entrypoint that wraps the classic DuckDB-Wasm worker:

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from './in-memory-catalog-controller.mjs'

// Create a combined worker that hosts both DuckDB-Wasm and the catalog store
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})

const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
await db.instantiate('/duckdb/duckdb-eh.wasm')
await db.open({
  allowUnsignedExtensions: true, // Required for custom Wasm extensions
  maximumThreads: 1,
})
```

### 2. Define a Snapshot and Initialize the Catalog

```js
// Define your catalog structure declaratively
const snapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'v1', // Cache identity key
          scanner: { type: 'parquet', options: {} },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'event_name', type: 'VARCHAR', nullable: true },
            { name: 'timestamp', type: 'TIMESTAMP', nullable: false },
          ],
          files: ['https://example.com/data/events-2026-09.parquet'],
        },
      ],
      views: [
        {
          name: 'login_events',
          query: "SELECT * FROM events WHERE event_name = 'login'",
        },
      ],
    },
  ],
}

// Attach the catalog to DuckDB
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    catalogName: 'app',
    extension: { url: '/extension/in_memory_catalog.duckdb_extension.wasm' },
  },
  snapshot,
)
```

### 3. Query the Catalog

Query tables and views using standard 3-part or 2-part identifiers:

```js
const result = await catalog.connection.query(`
  SELECT event_name, COUNT(*) AS count
  FROM app.analytics.login_events
  GROUP BY event_name
`)
console.log(result.toArray())
```

### 4. Update Tables Dynamically

Hot-swap a single table definition without disturbing other tables or re-attaching the catalog:

```js
await catalog.replaceTable('analytics', {
  name: 'events',
  snapshot: 'v2', // New snapshot ID invalidates DuckDB cache for this table
  scanner: { type: 'parquet', options: {} },
  columns: [
    { name: 'id', type: 'BIGINT', nullable: false },
    { name: 'event_name', type: 'VARCHAR', nullable: true },
    { name: 'timestamp', type: 'TIMESTAMP', nullable: false },
  ],
  files: [
    'https://example.com/data/events-2026-09.parquet',
    'https://example.com/data/events-2026-10.parquet',
  ],
})
```

---

## Supported File Formats

| Format | Scanner Type | Features |
|---|---|---|
| **Parquet** | `parquet` | Column projection pushdown, statistics filtering, physical schema validation against published metadata. |
| **CSV** | `csv` | Configurable delimiter, header, date/timestamp formatting, encoding, and strict validation. |
| **JSON** | `json` | Support for `newline_delimited` (NDJSON), JSON array, and auto formats. |
| **XLSX** | `xlsx` | Sheet selection, range filtering, and automatic header sniffing. |

For detailed scanner options, see the [Scanners Guide](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/scanners.html) · [日本語ドキュメント](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/scanners.html).

---

## Documentation

The full documentation is available online in English and Japanese:

- [**English Documentation**](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/)
  - [Getting Started](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/getting-started.html) — Prerequisites, asset preparation, and runtime setup.
  - [Guides](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/guides.html) — Publishing, atomic updates, view management, and lifecycle cleanup.
  - [Concepts](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/concepts.html) — Snapshots, cache isolation, runtime ownership, and read-only design principles.
  - [Scanners](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/scanners.html) — Options reference for Parquet, CSV, JSON, and XLSX.
  - [Reference](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/reference.html) — Snapshot schema specification, JavaScript API reference, error types.
- [**日本語ドキュメント**](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/)
  - [はじめに](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/getting-started.html)
  - [ガイド](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/guides.html)
  - [コンセプト](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/concepts.html)
  - [スキャナ](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/scanners.html)
  - [リファレンス](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/docs/ja/reference.html)

---

## Development

### Prerequisites

- Node.js 22+
- pnpm 10.17.1+
- Git submodules (`git submodule update --init --recursive`)
- Emscripten 3.1.56 (for building Wasm extensions from source)

### Commands

```sh
# Clone with submodules
git clone --recurse-submodules https://github.com/tokibi/duckdb-wasm-in-memory-catalog.git
cd duckdb-wasm-in-memory-catalog

# Install dependencies and verify
pnpm install --frozen-lockfile
pnpm check

# Build TypeScript library
pnpm build

# Build Wasm extension (requires Emscripten 3.1.56)
make build-wasm

# Build and preview documentation and demo site
pnpm build:pages
pnpm serve:pages
```

Open `http://127.0.0.1:4175/`. The live interactive demo is at `/` and the documentation site is at `/docs/`.

---

## Repository Layout

```text
extensions/in_memory_catalog/       DuckDB extension C++ build definition
src/in_memory_catalog_extension.cpp C++ extension implementation (DuckDB catalog hook)
src/javascript/                     TypeScript controller and Dedicated Worker runtime
demo/                               GitHub Pages browser interactive demo
docs/                               Documentation content (Ox Content / Vite)
scripts/build-wasm.sh               Wasm extension build script using versions.lock
scripts/build-pages.ts              Static pages builder for demo & assets
scripts/serve-pages.ts              Local Range-capable HTTP server for preview
test/unit/                          Vitest component tests
```

---

## Status

**Experimental**. The public API is actively evolving.

---

## License

[MIT](LICENSE)
