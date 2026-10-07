---
title: Reference
description: Snapshot スキーマ仕様、JavaScript API リファレンス、エラーハンドリング、制約事項をまとめます。
---

# Reference

## スナップショット形式

カタログの登録や全体更新では、カタログ全体の状態を表す完全な Snapshot オブジェクトを渡します。

```js
{
  format_version: 1,
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
            'https://example.test/files/events-r42.parquet',
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

### スナップショットフィールド一覧

| フィールド | 型 | 説明 |
|---|---|---|
| `format_version` | `number` | スナップショットのスキーマバージョン。現在は `1`。 |
| `schemas` | `Array` | カタログに含まれるスキーマの一覧。 |
| `schemas[].name` | `string` | DuckDB スキーマ名。 |
| `schemas[].tables` | `Array` | スキーマに含まれるテーブル定義の配列。 |
| `schemas[].views` | `Array` | スキーマに含まれるビュー定義の配列。 |
| `tables[].name` | `string` | DuckDB テーブル名。 |
| `tables[].snapshot` | `string` | キャッシュ分離のためのテーブル内容・スキーマ識別キー。 |
| `tables[].scanner` | `object` | ファイルスキャナ設定。`type` と `options` を指定。 |
| `tables[].columns` | `Array` | 列定義の配列。順序を保持。 |
| `tables[].files` | `string[]` | テーブルを構成するファイル URI の配列。 |
| `views[].name` | `string` | DuckDB ビュー名。 |
| `views[].query` | `string` | ビューを定義する単一の `SELECT` SQL 文。 |

> [!NOTE]
> 同一スキーマ内のテーブル名とビュー名は大文字・小文字を区別せず共通の名前空間を使用します。ビューの列情報はクエリ実行時に動的に導出されるため、ビュー定義に `columns` は含めません。

### カラム定義

```js
{
  name: 'id',
  type: 'BIGINT',
  nullable: false,
}
```

- **スカラー型**: `BOOLEAN`, `TINYINT`, `SMALLINT`, `INTEGER`, `BIGINT`, `HUGEINT`, `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`, `FLOAT`, `DOUBLE`, `DECIMAL(p,s)`, `VARCHAR`, `BLOB`, `DATE`, `TIME`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, `INTERVAL` 等。
- **ネスト型**: `JSON`, `STRUCT(field type, ...)`, `LIST(type)` または `type[]`。最大 32 階層まで。

### スキャナ定義

```js
{
  type: 'parquet', // 'parquet' | 'csv' | 'json' | 'xlsx'
  options: {},
}
```

利用可能なオプションの詳細は [Scanners](./scanners.md) を参照してください。

---

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

DuckDB コネクションを作成し、拡張機能をロードして初期スナップショットを登録し、読み取り専用カタログとして DuckDB に attach します。

#### `options` パラメータ

| プロパティ | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `workspaceId` | 任意 | `crypto.randomUUID()` | セッションおよびワークスペース識別子。 |
| `catalogName` | **必須** | — | DuckDB 内で利用するカタログ名。 |
| `extension` | 任意 | `{ name: 'in_memory_catalog' }` | 拡張機能のロード設定。`url` による直接ロード、または `name` と `repository` によるインストールを指定。 |
| `ackTimeoutMs` | 任意 | `5000` | Worker からの応答待ちタイムアウト。ミリ秒単位。 |
| `onRecoveryRequired` | 任意 | — | 排他的な更新やクリーンアップの失敗時に呼ばれる復旧要請コールバック。 |

---

### `createInMemoryCatalogWorker()`

```js
const worker = createInMemoryCatalogWorker({
  duckdbWorker: '/duckdb/duckdb-browser-eh.worker.js',
})
```

DuckDB-Wasm とカタログメタデータストアが同居する Dedicated Worker を作成します。
- `duckdbWorker`: DuckDB-Wasm の Classic Worker URL を指定します。

---

### `catalog.query(sql)`

カタログを attach したコネクションでクエリを実行し、全結果を取得してから返します。クエリ、メタデータ操作、排他的な更新は、コントローラーごとの共通キューで呼び出し順に実行されます。戻り値は元のコネクションのクエリ結果（Arrow Table など）です。

### `catalog.withExclusiveUpdate(callback)`

先に受け付けた操作の完了を待ってからコールバックを実行します。コールバックと、その中で登録したメタデータ操作が完了するまで、後続のクエリを待機させます。

```js
await catalog.withExclusiveUpdate(async (update) => {
  await storage.overwrite(fileId, parquetBytes)
  await update.replaceTable('analytics', {
    ...currentTable,
    snapshot: nextSnapshotId,
  })
})
```

コールバックには `publishSnapshot`、`replaceTable`、`replaceView` を持つ `update` が渡されます。引数はコントローラーの同名メソッドと同じです。ファイル本体の更新をコールバック内で行い、変更した各テーブルの `snapshot` を新しい値にしてメタデータを更新します。コールバックの戻り値は `withExclusiveUpdate` の戻り値になります。

- コールバック内では渡された `update` を使ってください。**`catalog.query`、`diagnostics`、`close`、別の `withExclusiveUpdate` を呼んで待たないでください。** これらは現在のコールバックの終了を待つため、互いに待機したままになります。コントローラー直接のメタデータ更新メソッドは、排他的な更新中はエラーになります。
- 更新が不要な場合など、メタデータを更新せずにコールバックを終了できます。正常終了するとクエリを再開します。`update` はコールバック終了後には使えません。登録済みの操作は `await` されていなくても完了を待ちますが、アプリケーションでは順序を明確にするため `await` してください。
- コールバックやメタデータ更新が失敗すると `state` が `failed_closed` になり、`onRecoveryRequired` が呼ばれます。コールバック内で更新エラーを捕捉しても再開しません。元のエラーを返し、待機中および新しいクエリは `RC_CATALOG_RECOVERY_REQUIRED` で拒否します。
- ファイル本体の更新はロールバックしません。復旧時はこのコントローラーを閉じ、ファイルとメタデータを修復してから、整合したスナップショットで新しいコントローラーを初期化してください。失敗したコントローラーを再開する API はありません。
- 保証対象は同じコントローラーに渡した操作です。生のコネクション、ストリーミング、prepared statement、別のコントローラーやタブ、外部アプリによる更新は対象外です。Gateway や HTTP キャッシュも更新後の内容を返す必要があります。カタログの `snapshot` が切り替えるのは DuckDB 内のキャッシュ識別子です。

### `catalog.connection`

高度な操作向けの、生の DuckDB コネクションです。ここからのクエリ、ストリーミング、prepared statement はコントローラーのキューを通りません。`withExclusiveUpdate` で保護する読み取りには `catalog.query` を使ってください。

---

### `catalog.publishSnapshot(snapshot)`

新しい完全スナップショットを登録し、カタログ全体を一括更新します。

```js
await catalog.publishSnapshot(nextSnapshot)
```

---

### `catalog.replaceTable(schemaName, table)`

既存の単一テーブルの定義のみを更新します。

```js
await catalog.replaceTable('analytics', {
  name: 'events',
  snapshot: 'v2',
  scanner: { type: 'parquet', options: {} },
  columns: [...],
  files: [...],
})
```

---

### `catalog.replaceView(schemaName, view)`

既存の単一ビューのクエリ定義のみを更新します。

```js
await catalog.replaceView('analytics', {
  name: 'recent_events',
  query: 'SELECT * FROM events WHERE is_active = true',
})
```

---

### `catalog.diagnostics()`

Worker 側のセッション状態、登録テーブル数、内部世代カウンタなどの診断情報を返します。

---

### `catalog.close()`

新しい操作を拒否し、受け付け済みの操作が終わってからカタログを detach して Worker 内の状態を破棄します。先行する排他的な更新が失敗した場合、受け付け済みのクエリも実行せずに拒否します。

---

## エラーハンドリング

コントローラーのエラーは `InMemoryCatalogControllerError` としてスローされます。

| エラーコード | 原因 |
|---|---|
| `RC_METADATA_INVALID` | スナップショットまたはテーブル定義の構文・型が不正。 |
| `RC_CATALOG_SCHEMA_NOT_FOUND` | 単一更新の対象スキーマが存在しない。 |
| `RC_CATALOG_TABLE_NOT_FOUND` | 単一更新の対象テーブルが存在しない。 |
| `RC_CATALOG_VIEW_NOT_FOUND` | 単一更新の対象ビューが存在しない。 |
| `RC_REMOTE_IO` | Worker との通信失敗、タイムアウト、不正レスポンス。 |
| `RC_CATALOG_WORKSPACE_CLOSED` | すでに closed 状態のコントローラーに対して操作を実行した。 |
| `RC_CATALOG_RECOVERY_REQUIRED` | 排他的な更新やクリーンアップに失敗し、コントローラーの再作成が必要。 |
| `RC_CATALOG_UPDATE_SCOPE` | 排他的な更新中にコントローラー直接の更新メソッドを使った、または終了済みの `update` を使った。 |
| `RC_METADATA_GENERATION_EXHAUSTED` | 内部世代カウンタの上限に達したためワークスペースの再作成が必要。 |

---

## 現在の制約事項

- **公開 API のステータス**: Experimental。
- **読み取り専用**: DuckDB からの DDL や DML はサポートしていません。
- **スキーマ自動推論なし**: ホストアプリケーション側で `columns` の型を明示する必要があります。
- **キャッシュ分離**: URL フラグメントによる分離は DuckDB 内部のキャッシュキーを分ける仕組みであり、サーバー側のリソース自体をバージョン管理するものではありません。
- **XLSX スキャナ**: 1 テーブルにつき 1 ファイルのみ指定可能で、`.xlsx` のみに対応します。`.xls` には対応しません。
