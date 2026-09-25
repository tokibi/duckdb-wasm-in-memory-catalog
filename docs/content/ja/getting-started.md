---
title: はじめに
description: DuckDB-Wasm をセットアップし、in-memory catalog を初期化して最初のクエリを実行します。
---

# はじめに

DuckDB-Wasm のデータベースから in-memory catalog をクエリできる状態までの手順を説明します。

> [!NOTE]
> 現在このライブラリは npm package として公開されていません。以下では、リポジトリからビルドした JavaScript モジュールとブラウザアセットを利用します。

---

## 全体の手順

1. **アセットを準備し、Dedicated Worker と DuckDB-Wasm を初期化する**
2. **テーブルやビューのスナップショットを定義する**
3. **カタログを初期化して SQL クエリを実行する**

---

## 1. Browser アセットを準備する

Catalog は、DuckDB-Wasm の Classic Worker スクリプトを読み込む専用の Worker エントリーポイントを必要とします。同じ Dedicated Worker 内でカタログストアと DuckDB-Wasm が動作することで、Wasm 拡張機能からメタデータストアへ同期的にアクセスできます。

Web サーバーまたは静的配信ホストに、以下のアセットを配置します：

```text
/in-memory-catalog/
  ├── in-memory-catalog-controller.mjs     # メインスレッド用コントローラー
  ├── in-memory-catalog-worker.js         # Dedicated Worker エントリーポイント
  ├── in-memory-catalog-metadata-store.js # カタログメタデータ管理
  └── in-memory-catalog-worker-runtime.js # Worker 側ランタイム
/duckdb/
  ├── duckdb-browser-eh.worker.js         # DuckDB-Wasm Classic Worker
  └── duckdb-eh.wasm                      # DuckDB-Wasm wasm_eh バイナリ
/extension/
  └── in_memory_catalog.duckdb_extension.wasm # カタログ Wasm 拡張機能
```

> [!TIP]
> 具体的な配置やビルド方法は、本リポジトリの `scripts/build-pages.ts` を参照してください。

---

## 2. Dedicated Worker と DuckDB-Wasm を初期化する

メインスレッドの JavaScript から `createInMemoryCatalogWorker` を呼び出し、DuckDB-Wasm とカタログが同居する Worker を生成します。

```js
import * as duckdb from '@duckdb/duckdb-wasm'
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from '/in-memory-catalog/in-memory-catalog-controller.mjs'

// 1. DuckDB-Wasm Worker を内包する専用 Worker を作成
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})

// 2. DuckDB-Wasm インスタンスを初期化
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
await db.instantiate('/duckdb/duckdb-eh.wasm')

// 3. データベースを開く
await db.open({
  allowUnsignedExtensions: true, // カスタム Wasm 拡張機能を読み込むために必須
  maximumThreads: 1,
  filesystem: {
    reliableHeadRequests: false,
    allowFullHTTPReads: true,
    forceFullHTTPReads: false,
  },
})
```

> [!IMPORTANT]
> - `allowUnsignedExtensions: true` は、本拡張機能（Wasm）を DuckDB に読み込ませるために指定が必要です。
> - 指定する Worker URL は Classic Worker である必要があります。Module Worker には対応していません。
> - CORS や CSP がリモートファイルおよび Worker スクリプトの読み込みを許可していることを確認してください。

---

## 3. スナップショットを定義する

スナップショットは、カタログ全体のテーブルやビューの構造を宣言的に定義する JSON オブジェクトです。

```js
const snapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          snapshot: 'events-v1', // キャッシュ識別子
          scanner: {
            type: 'parquet',     // 'parquet', 'csv', 'json', 'xlsx'
            options: {},
          },
          columns: [
            { name: 'id', type: 'BIGINT', nullable: false },
            { name: 'event_type', type: 'VARCHAR', nullable: true },
            { name: 'created_at', type: 'TIMESTAMP', nullable: false },
          ],
          files: [
            'https://example.com/data/events-2026.parquet',
          ],
        },
      ],
      views: [
        {
          name: 'important_events',
          query: "SELECT * FROM events WHERE event_type IS NOT NULL",
        },
      ],
    },
  ],
}
```

- **`scanner`**: ファイルの解釈方法を指定します。拡張子からの自動推論は行いません。CSV の場合は `type: 'csv'` とオプションを指定します。
- **`snapshot`**: テーブルのキャッシュキーです。リモートファイルの内容やスキーマを変更した際にこの文字列を変えることで、DuckDB のキャッシュが無効化されます。

---

## 4. カタログを初期化する

`InMemoryCatalogController.initialize` を呼び出すと、Wasm 拡張機能のロード、スナップショットの送信、および DuckDB へのカタログの attach が行われます。

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId: crypto.randomUUID(), // セッション識別子
    catalogName: 'app',                // DuckDB 内で利用するカタログ名
    extension: {
      url: '/extension/in_memory_catalog.duckdb_extension.wasm',
    },
  },
  snapshot,
)
```

---

## 5. SQL クエリを実行する

初期化完了後、`catalog.connection` を使って標準の SQL でクエリを実行できます。

```js
const result = await catalog.connection.query(`
  SELECT event_type, COUNT(*) AS count
  FROM app.analytics.events
  GROUP BY event_type
  ORDER BY count DESC
`)

console.log(result.toArray())
```

---

## 6. クリーンアップ

利用が終了したら、コントローラーと DuckDB をクローズします：

```js
// カタログを detach し、Worker 内のスナップショット状態を破棄
await catalog.close()

// DuckDB インスタンスと Worker を終了
await db.terminate()
worker.terminate()
```

---

## 最小の動作コード例

1つのファイルで動作を確認できるコード例です：

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>DuckDB-Wasm In-Memory Catalog Quickstart</title>
</head>
<body>
  <h1>DuckDB-Wasm In-Memory Catalog</h1>
  <pre id="output">初期化中...</pre>

  <script type="module">
    import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm'
    import {
      createInMemoryCatalogWorker,
      InMemoryCatalogController,
    } from '/in-memory-catalog/in-memory-catalog-controller.mjs'

    const output = document.getElementById('output')

    try {
      // 1. Worker と DuckDB のセットアップ
      const worker = createInMemoryCatalogWorker({
        duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
      })
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
      await db.instantiate('/duckdb/duckdb-eh.wasm')
      await db.open({ allowUnsignedExtensions: true })

      // 2. メタデータスナップショットの定義
      const snapshot = {
        format_version: 1,
        schemas: [
          {
            name: 'main',
            tables: [
              {
                name: 'users',
                snapshot: 'v1',
                scanner: { type: 'parquet', options: {} },
                columns: [
                  { name: 'id', type: 'BIGINT', nullable: false },
                  { name: 'name', type: 'VARCHAR', nullable: true },
                ],
                files: ['https://example.com/users.parquet'],
              },
            ],
          },
        ],
      }

      // 3. カタログの初期化
      const catalog = await InMemoryCatalogController.initialize(
        db,
        worker,
        {
          catalogName: 'my_data',
          extension: { url: '/extension/in_memory_catalog.duckdb_extension.wasm' },
        },
        snapshot,
      )

      // 4. クエリ実行
      const result = await catalog.connection.query('SELECT * FROM my_data.main.users')
      output.textContent = JSON.stringify(result.toArray(), null, 2)

    } catch (err) {
      output.textContent = 'エラー: ' + err.message
      console.error(err)
    }
  </script>
</body>
</html>
```

---

## 次に読むもの

- [**ガイド**](./guides.md): 単一テーブルの置換（`replaceTable`）やビューの更新、実運用の方法。
- [**スキャナ**](./scanners.md): CSV、JSON、XLSX の設定と詳細オプション。
- [**コンセプト**](./concepts.md): スナップショットのライフサイクルとキャッシュ分離の仕組み。
