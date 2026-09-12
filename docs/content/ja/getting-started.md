---
title: Getting started
description: DuckDB-Wasm をセットアップし、in-memory catalog を初期化して最初のクエリを実行します。
---

# Getting started

DuckDB-Wasm の database から in-memory catalog をクエリできる状態まで、最短の手順を説明します。

## 1. DuckDB-Wasm を準備する

通常どおり DuckDB Worker と database を作成します。これらの lifecycle はホストアプリケーションが管理します。

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import { InMemoryCatalogController } from 'duckdb-wasm-in-memory-catalog'

const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
const worker = new Worker(bundle.mainWorker)
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)

await db.instantiate(bundle.mainModule)
```

Catalog controller は DuckDB-Wasm と同じ Worker を利用します。これにより extension からアプリケーション側の metadata store を参照できます。

## 2. Snapshot を定義する

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

## 3. Catalog を初期化する

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

## 4. Query する

```js
const result = await catalog.connection.query(`
  SELECT id, category
  FROM app.analytics.events
`)
```

Attach された catalog を使う query は `catalog.connection` から実行します。

## 5. 終了する

```js
await catalog.close()
await db.terminate()
worker.terminate()
```

Controller を close すると catalog を detach し、Worker 側の snapshot を破棄します。DuckDB Worker 自体は terminate しません。

## 次に読むもの

Catalog の publish / update の実践的な使い方は [Guides](./guides.md)、revision・snapshot・scanner・cache の意味は [Concepts](./concepts.md) を参照してください。
