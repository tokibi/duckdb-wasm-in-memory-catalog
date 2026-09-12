---
title: DuckDB-Wasm In-Memory Catalog
description: アプリケーションが管理するテーブルメタデータを、ブラウザ上の読み取り専用 DuckDB カタログとして公開します。
---

# DuckDB-Wasm In-Memory Catalog

アプリケーションが管理するテーブルメタデータを、ブラウザ上の読み取り専用 DuckDB カタログとして公開します。

ホストアプリケーションが schema、table、column、scanner、file のメタデータを管理し、その状態を DuckDB-Wasm へカタログとして公開します。アプリケーション側のデータモデルを `CREATE TABLE` の列として重複管理する必要はありません。

すでに宣言的なデータセットモデルを持つアプリケーションから、そのまま DuckDB-Wasm で通常のカタログとしてクエリしたい場合に利用できます。

## 主な機能

- アプリケーション管理のメタデータを読み取り専用 DuckDB カタログとして公開
- 完全な catalog snapshot の atomic な更新
- scanner と file URI の明示的な定義
- DuckDB の file / Parquet cache を分離する table 単位の snapshot identity
- lifecycle、publish、diagnostics、cleanup を扱う JavaScript controller

## はじめに

1. [Getting started](./getting-started.md) でランタイムをセットアップします。
2. [Guides](./guides.md) で catalog の publish / update 方法を確認します。
3. アプリケーションへ組み込む前に [Concepts](./concepts.md) で catalog model を理解します。
4. メタデータ生成時は [Reference](./reference.md) の snapshot format を参照します。

[ライブデモ](../../) では、編集可能な snapshot と SQL を使って同じ catalog 実装をブラウザ上で試せます。

> [!NOTE]
> このプロジェクトは experimental であり、public API は今後変更される可能性があります。
