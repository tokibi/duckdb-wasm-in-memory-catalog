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
await catalog.update((update) => update.publishSnapshot(createSnapshot(datasets)))
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

await catalog.update((update) => update.publishSnapshot(nextSnapshot))
```

- **アトミック性**: 更新を呼び出し順にキューイングし、Dedicated Worker 内で検証した上でアトミックに適用します。不正なメタデータは反映しませんが、更新の失敗後は Worker を再作成するまでクエリを停止します。
- **注意点**: 非同期通信などで古いスナップショットが遅れて届く可能性がある場合は、アプリケーション側でタイムスタンプやバージョンを比較し、古い更新を破棄してください。

---

## 更新にコールバックを使う理由

一つの SQL クエリでも、ファイルの読み取りは一回で済むとは限りません。例えばリモートの Parquet を読む場合、まずフッターのメタデータから列や行グループの位置を調べ、その後、必要な行データを追加の Range リクエストで取得することがあります。

その間にファイルが上書きされると、古いファイルのメタデータと新しいファイルの行データが混ざる可能性があります。位置や長さが合わなくなり、読み取りエラーや不整合な結果につながります。カタログの `snapshot` を変えるだけでは、後続の読み取りのキャッシュ識別子が変わるだけで、進行中の読み取りを同じファイルの版に揃えることはできません。

そこで `catalog.update(callback)` は、メタデータの反映だけでなく、更新処理全体を次の順序で保護します。

1. 同じ Worker で実行中の通常のクエリが終わるのを待ち、新しいクエリの開始を止めます。
2. コールバック内でファイル本体を更新し、新しいカタログメタデータを反映します。
3. コールバックと登録済みのメタデータ操作が完了したら、待機中のクエリを再開します。更新に失敗した場合は、復旧するまで停止を維持します。

`update` に渡す関数の API 上の呼び方は「コールバック関数」です。外側の変数を参照するクロージャにもできますが、ここではその呼び出しから完了までを保護範囲として使っています。`replaceTable` だけを排他しても、その前のファイル上書きを保護できません。そのため、メタデータだけを変更する場合も同じコールバック形式を使います。`initialize` による初期登録もこの経路を通ります。

## クエリの実行中にファイルを上書きする

読み取りには `catalog.connection.query(sql)` など、通常の DuckDB コネクションを使えます。ファイル本体とメタデータの更新を1つの排他的なコールバックにまとめます。

```js
await catalog.update(async (update) => {
  await storage.overwrite(fileId, parquetBytes)
  await update.replaceTable('main', {
    ...currentTable,
    snapshot: nextSnapshotId,
  })
})
```

先行する通常のクエリが完了してからファイルを書き換え、コールバックと登録済みのメタデータ更新が終わるまで、同じ Worker の全コネクションの後続クエリを待たせます。コールバック内のカタログ操作には渡された `update` だけを使い、DuckDB のクエリを呼んで待たないでください。更新が不要なら、メタデータを更新せずに終了できます。ファイルを変更した場合は、上の例のように対象テーブルの `snapshot` を更新してください。読み取り中のストリームがある場合は、更新を開始せずに拒否します。読み取りを完了またはキャンセルしてから再試行してください。更新中の新しいストリーム開始も拒否します。コールバックや更新に失敗した場合は DuckDB 操作を停止するため、ファイルとメタデータを修復して Worker とコントローラーを再作成してください。別の Worker・タブ・外部アプリの操作は調整しません。詳細は [API リファレンス](./reference.md#catalogupdatecallback)を参照してください。

## レシピ 3: 単一テーブルを置換する (`replaceTable`)

他のテーブルを再検証・再送することなく、指定したテーブルのファイルリストやスキーマ、スナップショットIDだけを部分更新できます。

```js
// 'main' スキーマの 'events' テーブルのみを更新
await catalog.update((update) => update.replaceTable('main', {
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
}))
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
await catalog.update((update) => update.publishSnapshot(snapshot))

// 2. ビューのクエリ定義を置換
await catalog.update((update) => update.replaceView('main', {
  name: 'active_users',
  query: 'SELECT id, email, created_at FROM users WHERE is_active = true AND verified = true',
}))
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
