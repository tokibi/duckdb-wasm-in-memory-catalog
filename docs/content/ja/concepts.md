---
title: Concepts
description: complete snapshot、table snapshot、scanner、file、runtime ownership の考え方を説明します。
---

# Concepts

## Catalog model

In-memory catalog は、ホストアプリケーションが管理するメタデータを読み取り専用で DuckDB に投影する仕組みです。

```text
application state
      │
      │ catalog snapshot / relation replacement
      ▼
Catalog controller
      │
      │ MessageChannel
      ▼
Dedicated Worker metadata store
      │
      │ table or view lookup
      ▼
in_memory_catalog extension
      │
      ▼
DuckDB-Wasm
```

Authority は常にアプリケーション側にあります。DuckDB からは schema、table、view、column が通常の catalog object として見えますが、その定義を DuckDB が所有するわけではありません。

## Catalog の更新

`publishSnapshot()` は catalog 全体の完全 snapshot を渡します。`replaceTable()` と `replaceView()` は既存の単一 relation の完全な定義を渡します。Controller は呼び出し時の内容を複製し、呼び出し順に Worker へ送ります。Worker は受け取ったメタデータを検証してから、現在の状態を原子的に更新します。検証に失敗しても現在の状態は変わりません。

成功した更新は呼び出し順に反映されます。全体置換はすべての状態を置き換え、単一 relation の置換は他の table と view を維持します。非同期処理で古い結果が遅れて届く場合は、アプリケーション側で publish 前に除外してください。

DuckDB のメタデータ更新検知と読み取り時の世代照合には、Worker が自動採番する内部カウンタを使います。同じ内容でも publish 成功ごとに進み、検証失敗時には変わりません。利用者が管理する必要はありません。

## View

`format_version: 3` では table とともに view を publish できます。View は名前と単一の `SELECT` query を持ち、利用時に DuckDB が query を bind して column と型を導出します。View から catalog の table や別の view を参照できます。不正な query や view の循環参照は query error になり、publish 済み snapshot は変更されません。

内部 catalog generation は bind 済み view entry の無効化にも使われます。`publishSnapshot()`、`replaceTable()`、`replaceView()` の成功後、次の query では現在の定義から view が bind されます。

## Table snapshot

Table の `snapshot` は、files が表す bytes と physical schema の identity です。File contents または physical schema が変わったときに変更します。

無関係な catalog 更新では table の `snapshot` を変えないことで、変更のない table の DuckDB file / Parquet cache identity を維持できます。

## Scanner と file

Table は次の3つの関心事を分離します。

```text
columns      DuckDB からどう見えるか
scanner      file をどう解釈するか
files[].uri  file がどこにあるか
```

1つの table を構成する file は同じ read configuration を共有する前提なので、scanner は table 単位です。

`format_version: 2` では scanner の明示指定が必須です。Catalog は filename、extension、URI から scanner を選びません。

現在はParquet、CSV、JSON、XLSXに対応しています。Scannerの設定と指定できるoptionは[Scanner](./scanners.md)を参照してください。

```js
scanner: {
  type: 'parquet',
  options: {},
}

```

Parquet scanner は published column の数、順序、名前、型と physical schema を検証します。CSV scanner は published column を read schema として使い、CSV header、column 数、値をその schema に対して検証します。CSV の既定値と option は [Scanner](./scanners.md) にまとめています。

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

Dataset または view を変更するときはアプリケーション状態を更新し、`publishSnapshot()`、`replaceTable()`、`replaceView()` で反映してください。
