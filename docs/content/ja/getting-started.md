---
title: Getting started
description: DuckDB-Wasm をセットアップし、in-memory catalog を初期化して最初のクエリを実行します。
---

# Getting started

DuckDB-Wasm の database から in-memory catalog をクエリできる状態まで、最短の手順を説明します。

> [!NOTE]
> 現在このリポジトリは npm package として公開されていません。以下では、このリポジトリから生成・配置した browser asset を使います。別の build system に組み込む場合も module と Worker の境界は同じです。

## 1. Browser asset を準備する

Catalog は DuckDB-Wasm の classic Worker script を読み込む custom Worker entrypoint を必要とします。アプリケーションが選択した DuckDB-Wasm bundle に対応する classic Worker URL を指定します。entrypoint はその Worker script を同じ Dedicated Worker 内で読み込むため、catalog extension から metadata bridge に同期アクセスできます。

アプリケーションから次の asset を配信します。

```text
/in-memory-catalog/in-memory-catalog-controller.mjs
/in-memory-catalog/in-memory-catalog-worker.js
/in-memory-catalog/in-memory-catalog-metadata-store.js
/in-memory-catalog/in-memory-catalog-worker-runtime.js
/duckdb/duckdb-browser-eh.worker.js
/duckdb/duckdb-eh.wasm
/extension/in_memory_catalog.duckdb_extension.wasm
```

`duckdb` のファイルは、互換性のある `@duckdb/duckdb-wasm` version から用意し、catalog extension はその DuckDB version と `wasm_eh` platform 向けに build します。具体的な配置方法は、このリポジトリの `scripts/build-pages.ts` を参考にできます。

## 2. Catalog Worker で DuckDB-Wasm を作成する

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from '/in-memory-catalog/in-memory-catalog-controller.mjs'

const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)

await db.instantiate('/duckdb/duckdb-eh.wasm')
await db.open({
  allowUnsignedExtensions: true,
  maximumThreads: 1,
  filesystem: {
    reliableHeadRequests: false,
    allowFullHTTPReads: true,
    forceFullHTTPReads: false,
  },
})
```

同じ Worker を DuckDB-Wasm と catalog controller の両方で利用します。通常の DuckDB browser Worker だけでは catalog 用の namespaced metadata message を処理できません。指定する URL は classic DuckDB-Wasm Worker である必要があり、module Worker には対応していません。Worker script と catalog の各 script は CSP の許可対象であり、必要な same-origin/CORS 条件を満たす必要があります。

ローカルで build した Wasm extension をロードするため、`allowUnsignedExtensions` が必要です。

## 3. Snapshot を定義する

Snapshot は、Worker が atomic に publish する catalog 全体の状態を表します。

```js
const snapshot = {
  format_version: 2,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'events-r1',
          scanner: {
            type: 'parquet',
            options: {},
          },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: true },
          ],
          files: [
            { uri: 'https://example.com/events.parquet' },
          ],
        },
      ],
    },
  ],
}
```

Catalog は filename や URI から scanner を推論しません。各 table が scanner を明示します。CSV file には `type: 'csv'` を指定し、delimiter や header などが既定値と異なる場合は対応する CSV option を指定します。利用できる option は [Scanner](./scanners.md) を参照してください。

## 4. Catalog を初期化する

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId: crypto.randomUUID(),
    catalogName: 'app',
    extension: {
      url: '/extension/in_memory_catalog.duckdb_extension.wasm',
    },
  },
  snapshot,
)
```

初期化時に Parquet support と catalog extension をロードし、initial snapshot を publish して catalog を read-only で attach します。互換性のある repository からインストールする場合は、`extension: { name: 'in_memory_catalog', repository: 'https://example.test/extensions' }` を指定できます。この場合は DuckDB の `INSTALL ... FROM ...` に続けて `LOAD ...` を実行します。Repository には、利用する DuckDB-Wasm version と `wasm_eh` platform に対応する binary が必要です。

## 5. Query する

```js
const result = await catalog.connection.query(`
  SELECT id, category
  FROM app.analytics.events
`)
```

Attach された catalog を使う query は `catalog.connection` から実行します。

## 6. 終了する

```js
await catalog.close()
await db.terminate()
worker.terminate()
```

Controller を close すると catalog を detach し、Worker 側の snapshot を破棄します。DuckDB Worker や database 自体は終了しません。

## 次に読むもの

Catalog の publish / update の実践的な使い方は [Guides](./guides.md)、snapshot・scanner・cache の意味は [Concepts](./concepts.md) を参照してください。
