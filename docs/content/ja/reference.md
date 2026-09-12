---
title: Reference
description: Snapshot schema、JavaScript API、error、現在の制約をまとめます。
---

# Reference

## Snapshot format

Catalog publication では `bigint` revision と catalog 全体の complete snapshot を送ります。

```js
{
  format_version: 2,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'events-r42',
          scanner: {
            type: 'parquet',
            options: {},
          },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: true },
          ],
          files: [
            { uri: 'https://example.test/files/events-r42' },
          ],
        },
      ],
    },
  ],
}
```

### Snapshot field

| Field | 意味 |
| --- | --- |
| `format_version` | Snapshot schema version。現在は `2`。 |
| `schemas` | アプリケーションが publish する schema 全体。 |
| `schemas[].name` | DuckDB schema 名。 |
| `schemas[].tables` | Schema に含まれる table。 |
| `tables[].name` | DuckDB table 名。 |
| `tables[].snapshot` | Scan cache を分離するための table content/schema identity。 |
| `tables[].scanner` | 明示的な file scanner configuration。 |
| `tables[].columns` | DuckDB 上の順序で定義した column。 |
| `tables[].files` | Table を構成する file。 |

### Column

各 column は次の形式です。

```js
{
  name: 'id',
  type: 'BIGINT',
  nullable: false,
}
```

Physical Parquet schema は published column の数、順序、名前、および互換性のある DuckDB type と一致する必要があります。

### Scanner

現在受け付ける形式は次のみです。

```js
{
  type: 'parquet',
  options: {},
}
```

空でない Parquet options と、Parquet 以外の scanner type は現在拒否されます。

### File

各 file descriptor は現在 URI を持ちます。

```js
{ uri: 'https://example.test/data/events.parquet' }
```

URI は location のみを表します。File format は `scanner` で指定します。

## JavaScript API

### `InMemoryCatalogController.initialize()`

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  options,
  initialRevision,
  initialSnapshot,
)
```

DuckDB connection を作成し、Parquet と catalog extension をロードし、Worker-side workspace session を開き、initial snapshot を publish して catalog を read-only で attach します。

`options`:

| Option | 必須 | Default | 意味 |
| --- | --- | --- | --- |
| `workspaceId` | yes | — | 空でない workspace/session identifier。 |
| `catalogName` | yes | — | DuckDB に attach するときの catalog 名。 |
| `extensionName` | no | `in_memory_catalog` | `LOAD` に渡す extension 名または URL。 |
| `ackTimeoutMs` | no | `5000` | Worker acknowledgement を待つ positive safe integer timeout。 |
| `onRecoveryRequired` | no | — | Cleanup 結果が不確実になった場合に呼ばれる callback。 |

`initialRevision` は unsigned 64-bit range 内の `bigint` である必要があります。

### `catalog.connection`

Catalog を attach した DuckDB connection です。Catalog を使う query はこの connection から実行します。

### `catalog.currentRevision`

直近で publish に成功した catalog revision です。

### `catalog.state`

Controller の lifecycle state です。正常に cleanup された場合の terminal state は `closed` です。

### `catalog.publishSnapshot(revision, snapshot)`

Catalog 全体を置き換える complete snapshot を publish します。Operation は呼び出し順に直列化されます。

### `catalog.diagnostics()`

それ以前に queue された operation の完了後、Worker-side catalog diagnostics を返します。

### `catalog.close()`

Catalog を detach して workspace を drop します。複数回呼んだ場合は同じ close promise を返します。

## Error behavior

Controller failure は `InMemoryCatalogControllerError` として throw され、machine-readable な `code` と message を持ちます。

主な code:

| Code | 意味 |
| --- | --- |
| `RC_METADATA_INVALID` | Controller input または catalog metadata が不正。 |
| `RC_REMOTE_IO` | Worker communication の失敗、timeout、想定外 response。 |
| `RC_CATALOG_WORKSPACE_CLOSED` | Controller が operation を受け付けなくなった後に呼び出した。 |
| `RC_CATALOG_RECOVERY_REQUIRED` | Cleanup に失敗し、対象 runtime の再作成が必要。 |

Snapshot validation では Worker / extension から追加の catalog-specific code が返ることがあります。分岐には error code を使い、message は診断情報として扱ってください。

## 現在の制約

- Public API は experimental。
- Read-only catalog。DuckDB 側からの catalog mutation は拒否される。
- `format_version: 2` のみ。
- Scanner は Parquet のみ。
- Parquet scanner options は現在空 object のみ。
- Host が完全な column metadata を与える必要があり、catalog 自体は schema inference を行わない。
- Table `snapshot` はアプリケーションが管理し、表す bytes または physical schema が変わったときに更新する必要がある。
- HTTP fragment による cache isolation は DuckDB 内部の cache key を分けるもの。Mutable remote resource を server 側で version-aware にするものではない。複数 version の query を同時実行するなら immutable/versioned URL が必要。

## Development

必要なもの:

- Node.js 22
- pnpm 10.17.1
- Git submodules
- Wasm build 用 Emscripten 3.1.56

```sh
git clone --recurse-submodules https://github.com/tokibi/duckdb-wasm-in-memory-catalog.git
cd duckdb-wasm-in-memory-catalog
corepack enable
pnpm install --frozen-lockfile
pnpm test
make build-wasm
```

Demo とドキュメントを build / preview するには:

```sh
pnpm build:pages
pnpm serve:pages
```

`http://127.0.0.1:4175/` を開いてください。ドキュメントは `/docs/` 配下です。
