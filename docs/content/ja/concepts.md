---
title: Concepts
description: catalog model、revision、table snapshot、scanner、file、runtime ownership の考え方を説明します。
---

# Concepts

## Catalog model

In-memory catalog は、ホストアプリケーションが管理するメタデータを読み取り専用で DuckDB に投影する仕組みです。

```text
application state
      │
      │ complete snapshot + revision
      ▼
Catalog controller
      │
      │ MessageChannel
      ▼
Dedicated Worker metadata store
      │
      │ table lookup
      ▼
in_memory_catalog extension
      │
      ▼
DuckDB-Wasm
```

Authority は常にアプリケーション側にあります。DuckDB からは schema、table、column が通常の catalog object として見えますが、その定義を DuckDB が所有するわけではありません。

## Complete snapshot

各 publication は patch ではなく catalog 全体の完全 snapshot を含みます。そのため同期結果が明確になり、publish 成功後の Worker-side metadata store は、その revision の状態と一致します。

新しい revision は前の snapshot を atomic に置き換えます。Validation に失敗しても catalog が部分的に更新されることはありません。

## Catalog revision と table snapshot

この2つは別の役割を持ちます。

**Catalog revision** は catalog 全体の publication 順序を表します。特定 table に関係しない metadata 変更でも、新しい catalog state を publish するなら増加させます。

**Table `snapshot`** は、その table の files が表す bytes と physical schema の identity です。File contents または physical schema が変わったときに変更します。

この2つを分けることで、無関係な catalog 更新によって全 table の DuckDB file / Parquet cache が invalidation されることを防ぎます。

## Scanner と file

Table は次の3つの関心事を分離します。

```text
columns      DuckDB からどう見えるか
scanner      file をどう解釈するか
files[].uri  file がどこにあるか
```

1つの table を構成する file は同じ read configuration を共有する前提なので、scanner は table 単位です。

`format_version: 2` では scanner の明示指定が必須です。Catalog は filename、extension、URI から scanner を選びません。

現在サポートされているのは次の形式です。

```js
scanner: {
  type: 'parquet',
  options: {},
}
```

Parquet scanner は published column の数、順序、名前、型と physical schema を検証します。

## Scan URI と cache identity

HTTP(S) file の場合、extension は table snapshot を fragment parameter として付加した内部 scan URI を生成します。

```text
metadata URI:
  https://example.test/files/events

DuckDB scan URI:
  https://example.test/files/events#duckdb-snapshot=events-r42
```

Fragment は browser / DuckDB 内部に留まり、HTTP request には送信されません。Remote request URL を変えずに DuckDB 側の cache key だけを変更できます。

HTTP(S) 以外の URI は変更せず DuckDB に渡されます。

## Runtime ownership

DuckDB Worker と database の lifecycle はホストアプリケーションが所有します。Controller が所有するのは catalog connection、Worker-side workspace session、attach した catalog です。

`close()` は queued publication の完了を待ち、catalog を detach し、Worker に workspace drop を要求して session / connection を閉じます。DuckDB Worker や database 自体は終了しません。

## Read-only である理由

Catalog mutation は意図的にサポートしていません。DuckDB 側の DDL を許すと、アプリケーションの data model と DuckDB catalog の2つが source of truth になってしまいます。

Dataset を変更するときはアプリケーション状態を更新し、新しい完全 snapshot を publish してください。
