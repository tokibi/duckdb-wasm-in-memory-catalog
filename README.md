# DuckDB-Wasm In-Memory Catalog

Publish application-owned table metadata as a read-only DuckDB catalog in the browser.

[**Live demo**](https://tokibi.github.io/duckdb-wasm-in-memory-catalog/) · [MIT License](LICENSE)

The application supplies complete schema, table, column, and file URI metadata. A Dedicated Worker validates each published revision and exposes table descriptors to the `in_memory_catalog` Wasm extension on demand.

File URIs are opaque to the Catalog. DuckDB-Wasm resolves and reads them through its configured filesystem when a query touches the corresponding table.

```mermaid
flowchart LR
  subgraph Main[Main Thread]
    App[Host application]
    Controller[Catalog controller]
  end
  subgraph Dedicated[Dedicated Worker]
    DuckDB[DuckDB-Wasm]
    Extension[in_memory_catalog extension]
    Worker[Catalog metadata store]
  end
  App -->|complete snapshot and revision| Controller
  Controller -->|MessageChannel| Worker
  DuckDB --> Extension
  Extension -->|table lookup| Worker
  Worker -->|columns and opaque file URIs| Extension
```

## Live demo

The GitHub Pages demo publishes a small Parquet fixture at `data/demo.parquet`. The browser inserts that same-origin HTTPS URL into the Catalog snapshot, then DuckDB-Wasm reads the Parquet file through its normal HTTP filesystem when SQL touches the table.

The DuckDB-Wasm runtime and default Catalog start automatically when the page opens. The demo shows the hosted fixture URL, row count, size, and columns alongside the runtime state. The Catalog JSON contains the resolved Pages URL and fixture content hash directly, and both the Catalog JSON and SQL remain editable before running a query.

```text
Catalog metadata
      │
      │ files[].uri = https://tokibi.github.io/duckdb-wasm-in-memory-catalog/data/demo.parquet
      ▼
DuckDB-Wasm
      │
      │ HTTPS / HTTP Range
      ▼
GitHub Pages
```

## Snapshot contract

Each publication contains a uint64 revision and a complete snapshot. A newer revision atomically replaces the current snapshot, the same revision with identical content is idempotent, and stale or conflicting revisions are rejected without changing the current state.

Enumeration returns schema names, table names, and column definitions without copying file URIs into DuckDB-Wasm. Table lookup returns the URI descriptors for the referenced table only. Catalog mutation statements are rejected because the application remains the metadata authority.

Example snapshot:

```js
{
  format_version: 1,
  schemas: [{
    name: 'analytics',
    tables: [{
      name: 'events',
      snapshot: 'events-r42',
      columns: [
        { name: 'id', type: 'BIGINT', nullable: false },
        { name: 'category', type: 'VARCHAR', nullable: true },
      ],
      files: [
        { uri: 'https://example.test/events-r42.parquet' },
      ],
    }],
  }],
}
```

## File contract

The current scan implementation loads DuckDB's Parquet dependency and validates each Parquet file against the published column count, order, names, and types.

Parquet is a consumer constraint of the current Catalog integration, not part of the file URI contract.

## Runtime ownership

The host application owns the DuckDB Worker and database lifecycle. It creates the Worker, initializes DuckDB-Wasm, then initializes the Catalog controller with the Worker, database, initial revision, and snapshot.

Closing the controller detaches the Catalog and drops its Worker-side snapshot without terminating the Worker.

## Repository layout

```text
extensions/in_memory_catalog/       DuckDB extension build definition
src/in_memory_catalog_extension.cpp extension implementation
src/javascript/                     controller and Dedicated Worker runtime
demo/                               GitHub Pages browser demo
scripts/build-wasm.sh               pinned Wasm extension build
scripts/build-pages.mjs             self-contained Pages artifact build
scripts/serve-pages.mjs             local Range-capable Pages preview
test/unit/                           JavaScript component contracts
```

DuckDB and Emscripten versions are pinned in `versions.lock`.

## Development

Requirements:

- Node.js 22
- Git submodules
- Emscripten 3.1.56 for Wasm builds

```sh
git clone --recurse-submodules https://github.com/tokibi/duckdb-wasm-in-memory-catalog.git
cd duckdb-wasm-in-memory-catalog
npm install
npm test
make build-wasm
```

The Wasm artifact is written to:

```text
build/wasm_eh/extension/in_memory_catalog/in_memory_catalog.duckdb_extension.wasm
```

To build and preview the same static artifact published by GitHub Pages:

```sh
make build-wasm
npm run build:pages
npm run serve:pages
```

Then open `http://127.0.0.1:4175/`.

## Status

Experimental. The public API is still evolving.

## License

MIT
