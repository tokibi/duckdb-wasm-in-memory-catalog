---
title: Getting started
description: DuckDB-Wasm をセットアップし、in-memory catalog を初期化して最初のクエリを実行します。
---

# Getting started

DuckDB-Wasm の database から in-memory catalog をクエリできる状態まで、最短の手順を説明します。

> [!NOTE]
> 現在このリポジトリは npm package として公開されていません。以下では、このリポジトリから生成・配置した browser asset を使います。別の build system に組み込む場合も module と Worker の境界は同じです。

## 1. Browser asset を準備する

Catalog は通常の DuckDB-Wasm Worker に加えて custom Worker wrapper を必要とします。この Worker 内で catalog router、metadata store、Worker runtime、DuckDB browser Worker をまとめて読み込みます。

アプリケーションから次の asset を配信します。

```text
/in-memory-catalog/in-memory-catalog-controller.mjs
/in-memory-catalog/in-memory-catalog-worker.js
/in-memory-catalog/common-worker-router.js
/in-memory-catalog/in-memory-catalog-metadata-store.js
/in-memory-catalog/in-memory-catalog-worker-runtime.js
/duckdb/duckdb-browser-eh.worker.js
/duckdb/duckdb-eh.wasm
/extension/in_memory_catalog.duckdb_extension.wasm
```

具体的な配置方法は、このリポジトリの `scripts/build-pages.mjs` を参考にできます。

## 2. Catalog Worker で DuckDB-Wasm を作成する

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import { InMemoryCatalogController } from '/in-memory-catalog/in-memory-catalog-controller.mjs'

const worker = new Worker('/in-memory-catalog/in-memory-catalog-worker.js')
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

同じ Worker を DuckDB-Wasm と catalog controller の両方で利用します。通常の DuckDB browser Worker だけでは catalog 用の namespaced metadata message を処理できません。

ローカルで build した Wasm extension をロードするため、`allowUnsignedExtensions` が必要です。

## 3. Snapshot を定義する

Snapshot は、ある revision 時点の catalog 全体を表します。

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

Catalog は filename や URI から scanner を推論しません。各 table が scanner を明示します。

## 4. Catalog を初期化する

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId: crypto.randomUUID(),
    catalogName: 'app',
    extensionName: '/extension/in_memory_catalog.duckdb_extension.wasm',
  },
  1n,
  snapshot,
)
```

初期化時に Parquet support と catalog extension をロードし、initial snapshot を publish して catalog を read-only で attach します。

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

Catalog の publish / update の実践的な使い方は [Guides](./guides.md)、revision・snapshot・scanner・cache の意味は [Concepts](./concepts.md) を参照してください。
