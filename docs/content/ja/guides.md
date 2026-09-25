---
title: Guides
description: in-memory catalog の公開、更新、クエリ、運用でよく使う実践的レシピを解説します。
---

# Guides

本ガイドでは、In-Memory Catalog を実際のアプリケーションに組み込んで運用する際の具体的なユースケースとレシピを解説します。

---

## レシピ 1: アプリケーション状態からカタログを公開する

アプリケーション側のデータモデルを唯一の Source of Truth とし、その状態から Snapshot を生成してコントローラーへ渡します。

```js
// アプリケーション内のデータセットモデル
const datasets = [
  {
    id: 'users',
    version: '2026-09-01',
    format: 'parquet',
    fields: [
      { name: 'id', type: 'BIGINT', nullable: false },
      { name: 'email', type: 'VARCHAR', nullable: true },
    ],
    url: 'https://cdn.example.com/users.parquet',
  },
]

// Snapshot オブジェクトに変換
function createSnapshot(datasetList) {
  return {
    format_version: 1,
    schemas: [
      {
        name: 'main',
        tables: datasetList.map((ds) => ({
          name: ds.id,
          snapshot: ds.version, // バージョンが変わるとキャッシュが無効化される
          scanner: { type: ds.format, options: {} },
          columns: ds.fields,
          files: [ds.url],
        })),
      },
    ],
  }
}

// カタログに反映
await catalog.publishSnapshot(createSnapshot(datasets))
```

これにより、`CREATE TABLE` などの DDL を組み立てて逐次実行する必要がなくなり、アプリケーション状態がそのままカタログ状態になります。

---

## レシピ 2: カタログ全体を一括更新する (`publishSnapshot`)

スキーマ構成の追加・削除や、複数テーブルを同時に切り替える場合は、新しい完全スナップショットを渡します。

```js
const nextSnapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'main',
      tables: [/* 新しいテーブル定義一覧 */],
      views: [/* 新しいビュー定義一覧 */],
    },
  ],
}

await catalog.publishSnapshot(nextSnapshot)
```

- **アトミック性**: コントローラーは呼び出し順にキューイングし、Dedicated Worker 内で検証した上でアトミックに適用します。検証に失敗した場合は現在のカタログが維持されます。
- **注意点**: 非同期通信などで古いスナップショットが遅れて届く可能性がある場合は、アプリケーション側でタイムスタンプやバージョンを比較し、古い更新を破棄してください。

---

## レシピ 3: 単一テーブルを置換する (`replaceTable`)

他のテーブルを再検証・再送することなく、指定したテーブルのファイルリストやスキーマ、スナップショットIDだけを部分更新できます。

```js
// 'main' スキーマの 'events' テーブルのみを更新
await catalog.replaceTable('main', {
  name: 'events',
  snapshot: 'events-v2', // スナップショットIDを更新して DuckDB キャッシュをリフレッシュ
  scanner: { type: 'parquet', options: {} },
  columns: [
    { name: 'id', type: 'BIGINT', nullable: false },
    { name: 'payload', type: 'JSON', nullable: true },
  ],
  files: [
    'https://cdn.example.com/events-part1.parquet',
    'https://cdn.example.com/events-part2.parquet',
  ],
})
```

- 対象テーブルが存在しない場合はエラーとなります。
- 他のテーブルの定義や DuckDB のキャッシュはそのまま維持されます。

---

## レシピ 4: SQL ビューの作成と更新 (`replaceView`)

テーブルの組み合わせや頻出のフィルタ条件を、あらかじめ SQL ビューとしてカタログに登録できます。

```js
// 1. スナップショット作成時にビューを登録
const snapshot = {
  format_version: 1,
  schemas: [
    {
      name: 'main',
      tables: [/* テーブル定義 */],
      views: [
        {
          name: 'active_users',
          query: 'SELECT id, email FROM users WHERE is_active = true',
        },
      ],
    },
  ],
}
await catalog.publishSnapshot(snapshot)

// 2. ビューのクエリ定義を置換
await catalog.replaceView('main', {
  name: 'active_users',
  query: 'SELECT id, email, created_at FROM users WHERE is_active = true AND verified = true',
})
```

- ビューの列や型は、DuckDB がクエリ実行時に SQL をバインドして動的に導出します。スナップショット内に `columns` の定義は不要です。
- テーブルやビューが更新されると、関連するビューのバインドは次のクエリ実行時に自動で再評価されます。

---

## レシピ 5: カタログへの SQL クエリ

通常の DuckDB と同様に、`catalog.schema.table` のような 3 部名または 2 部名で参照できます。

```sql
SELECT email, count(*)
FROM app.main.active_users
GROUP BY email;
```

`USE` コマンドでデフォルトのカタログ・スキーマを指定すると、テーブル名だけでクエリ可能です：

```js
await catalog.connection.query('USE app.main')

const res = await catalog.connection.query(`
  SELECT * FROM active_users LIMIT 10
`)
```

> [!WARNING]
> カタログは読み取り専用です。`INSERT`、`UPDATE`、`DROP TABLE` などの DDL や DML はエラーになります。データの変更は常にアプリケーション状態から `publishSnapshot` や `replaceTable` を経由して行ってください。

---

## レシピ 6: リモートファイルのアクセス設定

リモートの HTTP(S) ファイルを読み込む場合、DuckDB-Wasm のファイルシステム設定および CORS の設定が必要です。

```js
await db.open({
  allowUnsignedExtensions: true,
  maximumThreads: 1,
  filesystem: {
    reliableHeadRequests: false, // HEAD リクエストを避けて GET Range を優先
    allowFullHTTPReads: true,    // Range リクエスト非対応のサーバーでもフォールバック
    forceFullHTTPReads: false,
  },
})
```

### キャッシュの分離の仕組み
リモートファイルの更新時、DuckDB-Wasm の内部キャッシュが効いて古いデータを読んでしまうのを防ぐため、拡張機能は自動的に内部スキャン URL にフラグメントを付与します：

- メタデータ上の URL: `https://example.com/events.parquet`
- DuckDB 内部のスキャン URL: `https://example.com/events.parquet#duckdb-snapshot=events-v2`

ブラウザや CDN、Web サーバーへ送信される HTTP リクエストには `#` 以降は送信されないため、同一の URL を配信しながら DuckDB 側のキャッシュキーのみを一新できます。

---

## レシピ 7: 診断情報の取得 (`diagnostics`)

トラブルシューティングや Worker の内部状態を確認したい場合、`catalog.diagnostics()` を呼び出します。

```js
const info = await catalog.diagnostics()
console.log('Worker カタログ状態:', info)
```

Worker 側のセッション状態、登録されているスキーマ・テーブル数、内部世代カウンタなどが取得できます。

---

## レシピ 8: 復旧ハンドラとクリーンアップ

### 復旧ハンドラ (`onRecoveryRequired`)
コントローラーと Worker 間の通信異常などでクリーンアップ状態が不確定になった場合に備えて、初期化時に復旧ハンドラを登録できます：

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    catalogName: 'app',
    extension: { url: '/extension/in_memory_catalog.duckdb_extension.wasm' },
    onRecoveryRequired({ workspaceId }) {
      console.error('カタログランタイムの再作成が必要です:', workspaceId)
      // 必要に応じて Worker や DB インスタンスを再生成
    },
  },
  snapshot,
)
```

### クリーンアップ
コンポーネントのアンマウント時やセッション終了時にはクローズします：

```js
// キュー内の更新完了を待ち、カタログを detach してリソース解放
await catalog.close()
```
