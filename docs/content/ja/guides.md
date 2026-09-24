---
title: Guides
description: in-memory catalog の publish、update、query、運用でよく使うワークフローを説明します。
---

# Guides

## アプリケーション管理のデータセットを publish する

アプリケーション側のデータモデルを source of truth とし、その状態から完全な snapshot を生成して controller へ publish します。DuckDB に対して DDL を逐次実行して同期する必要はありません。

例えば、アプリケーションが dataset 名、column、file location、content version を持っているなら、catalog との境界で snapshot へ変換します。

```js
function toCatalogSnapshot(datasets) {
  return {
    format_version: 1,
    schemas: [
      {
        name: 'main',
        tables: datasets.map((dataset) => ({
          name: dataset.name,
          snapshot: dataset.contentVersion,
          scanner: { type: 'parquet', options: {} },
          columns: dataset.columns,
          files: dataset.files.map((file) => file.url),
        })),
      },
    ],
  }
}
```

これにより catalog 同期は宣言的になります。最新のアプリケーション状態が、そのまま最新の catalog 状態になります。

## Catalog を更新する

新しい完全 snapshot を publish します。

```js
await catalog.publishSnapshot(nextSnapshot)
```

Controller は呼び出し時の内容を複製し、呼び出し順に publish します。検証に成功した snapshot が現在の catalog 全体を一括置換します。非同期処理で古い結果が遅れて届く場合は、publish 前に除外してください。

各 table の `snapshot` は、その table の bytes または physical file schema が変わったときだけ変更します。

## 単一テーブルを更新する

既存のテーブルだけを更新する場合は、そのテーブルの完全な定義を渡します。

```js
await catalog.replaceTable('main', {
  name: 'events',
  snapshot: 'events-v2',
  columns: nextColumns,
  scanner: { type: 'parquet', options: {} },
  files: nextFiles,
})
```

Schema 名と table の `name` で対象を特定します。対象が存在しない場合はエラーになります。他のテーブルは再送・再検証せず、そのまま維持します。

`publishSnapshot()`、`replaceTable()`、`replaceView()` は共通のキューで呼び出し順に処理します。対象は処理時点の catalog から探します。後から全体置換すると、それ以前の relation 更新も含めて置き換わります。検証に失敗しても現在の状態は変わらず、次の更新を続けられます。

## View を publish・更新する

`format_version: 1` を使い、各 view を名前と単一の `SELECT` query で定義します。

```js
const snapshot = {
  format_version: 1,
  schemas: [{
    name: 'main',
    tables,
    views: [{
      name: 'active_events',
      query: 'SELECT * FROM events WHERE active',
    }],
  }],
}
await catalog.publishSnapshot(snapshot)
```

Catalog 全体を再送せずに既存 view を更新するには、完全な定義を渡します。

```js
await catalog.replaceView('main', {
  name: 'active_events',
  query: 'SELECT * FROM events WHERE active AND category IS NOT NULL',
})
```

名前は大文字・小文字を区別せずに照合されます。View の追加、削除、名前変更には `publishSnapshot()` を使います。構文エラー、参照先の欠落、互換性のない参照、循環参照は、query のために DuckDB が view を bind するときにエラーになります。

## Catalog を query する

通常の DuckDB と同じく catalog / schema / table で参照できます。

```sql
SELECT category, count(*)
FROM app.analytics.events
GROUP BY category;
```

Default catalog / schema を設定すれば短い query も使えます。

```js
await catalog.connection.query('USE app.analytics')
```

```sql
SELECT * FROM events;
```

Catalog の mutation statement は拒否されます。メタデータの authority は常にホストアプリケーションです。

## Remote file を使う

`files`の各文字列は場所だけを表し、形式は表しません。HTTP(S)ファイルを使う場合は、そのファイルにアクセスできるようDuckDB-Wasmのfilesystemを設定します。Parquet、CSV、JSON、XLSXに対応しており、`table.scanner`で明示的に選択します。Scanner optionは[Scanner](./scanners.md)を参照してください。

Extension は metadata 上の URI を変更せず保持し、DuckDB の scan 用には table snapshot を含む内部 URI を生成します。URL fragment は HTTP request には送られないため、gateway や Service Worker には元の base URI が届きます。

同じ remote URI の内容が更新される場合、table snapshot の publish と、その table を読む query を直列化してください。Query が content update をまたがないようにする必要があります。複数 version を同時に読む必要がある場合は、path や query parameter に immutable な version identity を含めてください。

## Diagnostics を確認する

```js
const diagnostics = await catalog.diagnostics()
console.log(diagnostics)
```

Publication 後の Worker-side workspace state を確認したり、metadata error を調査したりするときに利用できます。

## Cleanup が不確実な場合に復旧する

Controller の cleanup 結果が不確実になった場合に備えて `onRecoveryRequired` を指定できます。

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId,
    catalogName: 'app',
    extensionName,
    onRecoveryRequired({ workspaceId }) {
      console.error('Catalog runtime must be recreated', workspaceId)
    },
  },
  snapshot,
)
```

Recovery が必要になった場合、以前の workspace を安全に再利用できると仮定せず、対象 runtime を作り直してください。
