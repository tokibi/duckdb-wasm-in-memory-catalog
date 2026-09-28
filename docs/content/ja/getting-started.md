---
title: Getting Started
description: DuckDB-Wasm をセットアップし、in-memory catalog を初期化して最初のクエリを実行します。
---

# Getting Started

DuckDB-Wasm のデータベースから in-memory catalog をクエリできる状態までの手順を説明します。

> [!NOTE]
> 現在このライブラリは npm package として公開されていません。以下では、リポジトリからビルドした JavaScript モジュールとブラウザアセットを利用します。

## Quickstart の実行

ローカル CSV をテーブルとして公開し、ビューに対してクエリするページを用意しています。リポジトリのルートで次を実行してください。

```sh
pnpm install --frozen-lockfile
git submodule update --init --recursive
pnpm build:wasm
pnpm build:pages
pnpm serve:pages
```

[http://127.0.0.1:4175/quickstart/](http://127.0.0.1:4175/quickstart/) を開くと実行結果を確認できます。サンプルは `examples/quickstart/events.csv` を読み込むため、クエリ対象のデータを外部 URL から取得しません。`pnpm build:wasm` には `versions.lock` に記載された Emscripten が必要です。また、`pnpm build:pages` は全体デモ用の別データもダウンロードするため、ビルド時にはネットワーク接続が必要です。

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
  ├── duckdb-browser.mjs                # DuckDB-Wasm JavaScript API
  ├── duckdb-browser-eh.worker.js         # DuckDB-Wasm Classic Worker
  └── duckdb-eh.wasm                      # DuckDB-Wasm wasm_eh バイナリ
/vendor/
  ├── apache-arrow/                       # Apache Arrow JavaScript モジュール
  ├── flatbuffers/                        # FlatBuffers JavaScript モジュール
  └── tslib/                              # tslib JavaScript モジュール
/extension/
  └── in_memory_catalog.duckdb_extension.wasm # カタログ Wasm 拡張機能
```

> [!TIP]
> 具体的な配置やビルド方法は、本リポジトリの `scripts/build-pages.ts` を参照してください。

---

## 2. Dedicated Worker と DuckDB-Wasm を初期化する

メインスレッドの JavaScript から `createInMemoryCatalogWorker` を呼び出し、DuckDB-Wasm とカタログが同居する Worker を生成します。

```js
import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from '../in-memory-catalog/in-memory-catalog-controller.mjs'

// この例は examples/quickstart/app.js にあります。親ディレクトリがビルド後のサイトルートです。
const assetRoot = new URL('../', import.meta.url)
const duckdb = await import(new URL('duckdb/duckdb-browser.mjs', assetRoot).href)

// DuckDB-Wasm の Classic Worker を内包する Worker を作成
const worker = createInMemoryCatalogWorker({
  duckdbWorker: new URL('duckdb/duckdb-browser-eh.worker.js', assetRoot),
  workerUrl: new URL('in-memory-catalog/in-memory-catalog-worker.js', assetRoot),
})

// 2. DuckDB-Wasm インスタンスを初期化
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
await db.instantiate(new URL('duckdb/duckdb-eh.wasm', assetRoot).href)

// 3. データベースを開く
await db.open({
  allowUnsignedExtensions: true, // カスタム Wasm 拡張機能を読み込むために必須
  maximumThreads: 1,
  query: { castBigIntToDouble: true },
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
          snapshot: 'local-events-v1', // キャッシュ識別子
          scanner: {
            type: 'csv',
            options: { header: true },
          },
          columns: [
            { name: 'event_id', type: 'INTEGER', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: false },
            { name: 'value', type: 'INTEGER', nullable: false },
          ],
          files: [new URL('./events.csv', import.meta.url).href],
        },
      ],
      views: [
        {
          name: 'category_totals',
          query: "SELECT category, SUM(value) AS total FROM events GROUP BY category",
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
      url: new URL('extension/in_memory_catalog.duckdb_extension.wasm', assetRoot).href,
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
  SELECT category, total
  FROM app.analytics.category_totals
  ORDER BY category
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

実行可能な [Quickstart ページ](../quickstart/) と、そのソース `examples/quickstart/` を参照してください。ローカル CSV、テーブル、ビュー、クエリ、Worker の終了処理までを含みます。ブラウザー Worker と Wasm アセットを URL から読み込むため、HTML を `file://` で直接開かず、上記の手順で HTTP サーバーから開いてください。

---

## 次に読むもの

- [**Guides**](./guides.md): 単一テーブルの置換（`replaceTable`）やビューの更新、実運用の方法。
- [**Scanners**](./scanners.md): CSV、JSON、XLSX の設定と詳細オプション。
- [**Concepts**](./concepts.md): スナップショットのライフサイクルとキャッシュ分離の仕組み。
