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

### `catalog.update(callback)`

実行中の DuckDB リクエストが完了してから、カタログ Worker 内の排他ロックを取得してコールバックを実行します。コールバックと、その中で登録したメタデータ操作が完了するまで、通常のクエリを待機させます。同じ Worker 内の別のコネクションや prepared statement のクエリも対象です。

```js
await catalog.update(async (update) => {
  await storage.overwrite(fileId, parquetBytes)
  await update.replaceTable('analytics', {
    ...currentTable,
    snapshot: nextSnapshotId,
  })
})
```

カタログの更新はすべて `catalog.update` を通ります。`initialize` による初期スナップショットの登録も同じ経路です。コールバックには `publishSnapshot`、`replaceTable`、`replaceView` を持つ `CatalogUpdate` 型の更新ハンドルが渡され、これらのメソッドはコールバック内だけで利用できます。ファイル本体の更新もその中で行い、変更した各テーブルの `snapshot` を新しい値にしてメタデータを更新します。コールバックの戻り値は `catalog.update` の戻り値になります。

コールバックは、ファイル更新とメタデータ反映の両方が完了するまで読み取りを止めるための範囲を定義します。[更新にコールバックを使う理由](./guides.md#更新にコールバックを使う理由)で、Parquet の読み取りに起こり得る不整合を説明しています。

- コールバック内では渡された更新ハンドルを使ってください。**DuckDB のクエリ、`catalog.diagnostics`、`catalog.close`、別の `catalog.update` を呼んで待たないでください。** これらは現在のコールバックの終了を待つため、互いに待機したままになります。
- 更新が不要な場合など、メタデータを更新せずにコールバックを終了できます。正常終了するとクエリを再開します。更新ハンドルはコールバック終了後には使えません。メタデータの引数は、コールバックを予約した時点ではなく、ハンドルのメソッドを呼んだ時点でコピーされます。登録済みの操作は `await` されていなくても完了を待ちますが、アプリケーションでは順序を明確にするため `await` してください。
- コールバックやメタデータ更新が失敗すると `state` が `failed_closed` になり、`onRecoveryRequired` が呼ばれます。コールバック内で更新エラーを捕捉しても再開しません。元のエラーを返し、待機中および新しいクエリは `RC_CATALOG_RECOVERY_REQUIRED` で拒否します。
- ファイル本体の更新はロールバックしません。コールバックやメタデータ更新に失敗すると、その Worker の DuckDB 操作を停止します。復旧時はコントローラーを閉じ、ファイルとメタデータを修復してから、DuckDB Worker とコントローラーを再作成してください。失敗した Worker を再開する API はありません。
- 読み取り中のストリームや pending query がある場合は、完了またはキャンセルを待ってから更新を開始します。待機中も既存ストリームの poll・fetch・cancel は利用できます。待機中・実行中の新しいストリーム開始は拒否します。取得待機は `ackTimeoutMs`（既定 5000 ミリ秒）で制限され、タイムアウトするとロック取得の予約を取り消し、コールバックを実行せずに `RC_REMOTE_IO` を返します。ストリーム自体は自動キャンセルしません。予約の取り消しを確認できた場合、コントローラーは引き続き利用できます。
- Worker ごとに待機中・実行中の排他更新は1つです。別のコントローラーの更新が重なると、コールバックを実行せずに `RC_CATALOG_UPDATE_BUSY` を返します。先行する更新が終わってから再試行してください。標準 DuckDB-Wasm コネクションの `useUnsafe` による識別子取得を必要とし、これを持たない独自アダプターには `RC_CATALOG_WORKER_GATE_UNAVAILABLE` を返します。
- 排他範囲は DuckDB Worker 全体で、その中の全カタログ・テーブル・コネクションが対象です。テーブル単位のロックではありません。更新対象のテーブルはロック取得後のコールバック内で決まります。別の Worker・タブ・外部アプリによる更新は対象外です。Gateway や HTTP キャッシュも更新後の内容を返す必要があります。カタログの `snapshot` が切り替えるのは DuckDB 内のキャッシュ識別子です。

### `catalog.connection`

カタログを attach した DuckDB コネクションです。通常の `query` と prepared statement の `query` は Worker の排他制御で保護されます。同じ Worker の別のコネクションも対象です。メタデータの更新結果を使うクエリは、その更新を `await` してから実行してください。ストリーミングには上記の制約があります。

---

### `update.publishSnapshot(snapshot)`

新しい完全スナップショットを登録し、カタログ全体を一括更新します。

```js
await catalog.update((update) => update.publishSnapshot(nextSnapshot))
```

---

### `update.replaceTable(schemaName, table)`

既存の単一テーブルの定義のみを更新します。

```js
await catalog.update((update) => update.replaceTable('analytics', {
  name: 'events',
  snapshot: 'v2',
  scanner: { type: 'parquet', options: {} },
  columns: [...],
  files: [...],
}))
```

---

### `update.replaceView(schemaName, view)`

既存の単一ビューのクエリ定義のみを更新します。

```js
await catalog.update((update) => update.replaceView('analytics', {
  name: 'recent_events',
  query: 'SELECT * FROM events WHERE is_active = true',
}))
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
| `RC_CATALOG_RECOVERY_REQUIRED` | 排他的な更新やクリーンアップに失敗し、Worker とコントローラーの再作成が必要。 |
| `RC_CATALOG_UPDATE_SCOPE` | 更新範囲外・終了済みのハンドルを使った、または Worker のロックなしでメタデータを更新した。 |
| `RC_CATALOG_STREAM_ACTIVE` | 更新の待機中・実行中にストリームを開始した、または同じコネクションで別のストリームを開始した。 |
| `RC_CATALOG_UPDATE_BUSY` | 同じ Worker の別のコントローラーが更新を待機中または実行中。 |
| `RC_CATALOG_WORKER_GATE_UNAVAILABLE` | コネクションが Worker の排他制御に必要な識別子を公開していない。 |
| `RC_METADATA_GENERATION_EXHAUSTED` | 内部世代カウンタの上限に達したためワークスペースの再作成が必要。 |

---

## 現在の制約事項

- **公開 API のステータス**: Experimental。
- **読み取り専用**: DuckDB からの DDL や DML はサポートしていません。
- **スキーマ自動推論なし**: ホストアプリケーション側で `columns` の型を明示する必要があります。
- **キャッシュ分離**: URL フラグメントによる分離は DuckDB 内部のキャッシュキーを分ける仕組みであり、サーバー側のリソース自体をバージョン管理するものではありません。
- **XLSX スキャナ**: 1 テーブルにつき 1 ファイルのみ指定可能で、`.xlsx` のみに対応します。`.xls` には対応しません。
