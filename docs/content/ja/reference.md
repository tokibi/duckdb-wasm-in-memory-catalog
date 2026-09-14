---
title: Reference
description: Snapshot schema、JavaScript API、error、migration note、現在の制約をまとめます。
---

# Reference

## Snapshot format

Catalog publication では catalog 全体の complete snapshot を送ります。

```js
{
  format_version: 3,
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
      views: [
        {
          name: 'recent_events',
          query: "SELECT * FROM events WHERE occurred_at >= current_date - INTERVAL '7 days'",
        },
      ],
    },
  ],
}
```

### Snapshot field

| Field | 意味 |
| --- | --- |
| `format_version` | Snapshot schema version。Table のみなら `2`、view も含めるなら `3` を使う。 |
| `schemas` | アプリケーションが publish する schema 全体。 |
| `schemas[].name` | DuckDB schema 名。 |
| `schemas[].tables` | Schema に含まれる table。 |
| `schemas[].views` | Schema に含まれる view。`format_version: 3` で利用可能。 |
| `tables[].name` | DuckDB table 名。 |
| `tables[].snapshot` | Scan cache を分離するための table content/schema identity。 |
| `tables[].scanner` | 明示的な file scanner configuration。 |
| `tables[].columns` | DuckDB 上の順序で定義した column。 |
| `tables[].files` | Table を構成する file。 |
| `views[].name` | DuckDB view 名。 |
| `views[].query` | View を定義する単一の `SELECT` statement。 |

同じ schema 内の table 名と view 名は、大文字・小文字を区別しない共通の namespace を使います。Format 3 の schema には table、view、またはその両方を含められます。View の column と型は query の bind 時に DuckDB が導出するため、view metadata に `columns` はありません。

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
  initialSnapshot,
)
```

DuckDB connection を作成し、Parquet と catalog extension をロードし、Worker-side workspace session を開き、initial snapshot を publish して catalog を read-only で attach します。

`options`:

| Option | 必須 | Default | 意味 |
| --- | --- | --- | --- |
| `workspaceId` | yes | — | 空でない workspace/session identifier。 |
| `catalogName` | yes | — | DuckDB に attach するときの catalog 名。 |
| `extension` | no | `{ name: 'in_memory_catalog' }` | Extension のロード設定。`url` は Wasm extension の直接 `LOAD`、`name` と `repository` の組み合わせは `INSTALL ... FROM ...` と `LOAD` に使います。 |
| `extensionName` | no | — | 直接 `LOAD` する名前または URL を指定するための legacy alias。`extension` とは併用しません。 |
| `ackTimeoutMs` | no | `5000` | Worker acknowledgement を待つ positive safe integer timeout。 |
| `onRecoveryRequired` | no | — | Cleanup 結果が不確実になった場合に呼ばれる callback。 |

`extension` の例です。

```js
// アプリケーションから配信する extension asset を直接ロードする。
extension: {
  url: '/extension/in_memory_catalog.duckdb_extension.wasm',
}

// DuckDB extension repository から install してロードする。
extension: {
  name: 'in_memory_catalog',
  repository: 'https://example.test/extensions',
}
```

Extension binary は、アプリケーションが選択した DuckDB-Wasm version と `wasm_eh` platform に一致する必要があります。DuckDB-Wasm dependency と classic Worker URL はアプリケーションが用意します。Repository URL は DuckDB にそのまま渡されるため、利用する DuckDB-Wasm build が期待する repository layout と version/platform 解決を提供する必要があります。

### `createInMemoryCatalogWorker()`

```js
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})
```

DuckDB-Wasm と catalog が共有する classic Worker wrapper を作成します。`duckdbWorker` は必須で、選択した DuckDB-Wasm bundle に対応する classic Worker を指定します。現在の対応範囲は `wasm_eh` で、`wasm_mvp` と `coi` は対応 API の契約に含まれません。Worker URL と catalog の各 asset は、アプリケーションの CSP およびブラウザーの same-origin/CORS 条件を満たす必要があります。

### `catalog.connection`

Catalog を attach した DuckDB connection です。Catalog を使う query はこの connection から実行します。

### `catalog.state`

Controller の lifecycle state です。正常に cleanup された場合の terminal state は `closed` です。

### `catalog.publishSnapshot(snapshot)`

呼び出し時の snapshot を複製し、呼び出し順に publish します。検証に成功すると catalog 全体を一括置換します。最後に渡された有効な snapshot が現在の状態になります。戻り値は `Promise<void>` です。

### `catalog.replaceTable(schemaName, table)`

既存テーブルの定義全体を置換します。`table` は snapshot 内の table と同じ形式で、`name`、`snapshot`、`columns`、`scanner`、`files` が必要です。Schema 名と table 名は大文字・小文字を区別せずに照合し、既存の表記を維持します。追加・削除・名前変更には `publishSnapshot()` を使ってください。

入力は呼び出し時に複製され、全体置換と共通のキューで処理されます。成功すると対象テーブルだけを原子的に更新し、内部世代を進めます。戻り値は `Promise<void>` です。

### `catalog.replaceView(schemaName, view)`

Format 3 snapshot にある既存 view の定義全体を置換します。View は `name` と `query` だけを持ちます。Schema 名と view 名は大文字・小文字を区別せずに照合し、既存の表記を維持します。View の追加、削除、名前変更には `publishSnapshot()` を使ってください。

入力は呼び出し時に複製され、全体置換や単一テーブル置換と共通のキューで処理されます。成功すると対象 view だけを原子的に更新し、内部世代を進めます。戻り値は `Promise<void>` です。

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
| `RC_CATALOG_SCHEMA_NOT_FOUND` | 単一テーブル更新の対象 schema が存在しない。 |
| `RC_CATALOG_TABLE_NOT_FOUND` | 単一テーブル更新の対象 table が存在しない。 |
| `RC_CATALOG_VIEW_NOT_FOUND` | 単一 view 更新の対象 view が存在しない。 |
| `RC_REMOTE_IO` | Worker communication の失敗、timeout、想定外 response。 |
| `RC_CATALOG_WORKSPACE_CLOSED` | Controller が operation を受け付けなくなった後に呼び出した。 |
| `RC_CATALOG_RECOVERY_REQUIRED` | Cleanup に失敗し、対象 runtime の再作成が必要。 |
| `RC_METADATA_GENERATION_EXHAUSTED` | Private な internal generation の上限に達した。Workspace を再作成する必要がある。 |

Snapshot validation では Worker / extension から追加の catalog-specific code が返ることがあります。分岐には error code を使い、message は診断情報として扱ってください。

View を parse または bind できない場合、DuckDB query は `RC_CATALOG_VIEW_INVALID` を報告します。View の依存関係が循環している場合は `RC_CATALOG_VIEW_CYCLE` を報告します。これらは `InMemoryCatalogControllerError.code` ではなく、DuckDB query の error message に含まれます。

## Revision-based publication からの移行

`initialize(db, worker, options, initialRevision, initialSnapshot)` から `initialRevision` を削除し、`publishSnapshot(snapshot)` には snapshot だけを渡してください。`catalog.currentRevision` の参照も削除します。Bytes、physical schema、cache identity のために各 table の `snapshot` は引き続き管理します。Catalog generation は private な bridge state です。

## 現在の制約

- Public API は experimental。
- ホストアプリケーションは DuckDB-Wasm version と、それに対応する `wasm_eh` catalog extension binary を用意する必要があります。
- Extension build では、`versions.lock` に指定された DuckDB commit と Emscripten version を使用します。これはホストアプリケーションが選択する DuckDB-Wasm version とは別の build input です。
- Read-only catalog。DuckDB 側からの catalog mutation は拒否される。
- `format_version: 2` は table、`format_version: 3` は view もサポートする。
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
