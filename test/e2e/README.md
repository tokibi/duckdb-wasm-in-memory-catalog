# Browser integration test

From the repository root, with the pinned Emscripten toolchain and DuckDB submodule installed:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
make build-wasm
pnpm build:pages
pnpm test:e2e
```

The test starts the Pages server locally and launches Chromium. It loads the actual built Wasm extension in DuckDB-Wasm, checks the live demo, queries Parquet, CSV, JSON, and XLSX data and a view, then calls `replaceTable` and queries the table and view again. `build:pages` fetches pinned demo data from external sources; the test itself uses only files served locally.
