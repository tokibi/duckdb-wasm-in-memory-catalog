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
    format_version: 2,
    schemas: [
      {
        name: 'main',
        tables: datasets.map((dataset) => ({
          name: dataset.name,
          snapshot: dataset.contentVersion,
          scanner: { type: 'parquet', options: {} },
          columns: dataset.columns,
          files: dataset.files.map((file) => ({ uri: file.url })),
        })),
      },
    ],
  }
}
```

これにより catalog 同期は宣言的になります。最新のアプリケーション状態が、そのまま最新の catalog 状態になります。

## Catalog を更新する

単調増加する `bigint` revision と新しい完全 snapshot を publish します。

```js
await catalog.publishSnapshot(2n, nextSnapshot)
```

Controller は publication を直列化します。新しい revision は現在の snapshot を atomic に置き換えます。同一 revision・同一内容の再 publish は idempotent です。古い revision や、同じ revision に異なる内容を割り当てる操作は拒否されます。

Global な catalog revision を table の content version として使わないでください。各 table の `snapshot` は独立して管理し、その table の bytes または physical Parquet schema が変わったときだけ変更します。

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

`files[].uri` は location を表すだけで、format は表しません。HTTP(S) file を使う場合は、その remote resource にアクセスできるよう DuckDB-Wasm filesystem を設定します。現在サポートされている scanner は Parquet のみです。

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
  revision,
  snapshot,
)
```

Recovery が必要になった場合、以前の workspace を安全に再利用できると仮定せず、対象 runtime を作り直してください。
