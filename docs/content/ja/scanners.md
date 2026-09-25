---
title: Scanners
description: In-Memory Catalog が対応する Parquet、CSV、JSON、XLSX スキャナの設定方法とオプション一覧。
---

# Scanners

In-Memory Catalog では、各テーブルに必ず 1 つの `scanner` を明示的に指定します。ファイル名や拡張子、URI からスキャナを推論することはありません。また、1 つのテーブルに登録されたすべてのファイルは同じスキャナ設定を共有します。

---

## 対応スキャナ一覧

| スキャナ | `type` | 主な特徴 | 複数ファイル対応 |
|---|---|---|---|
| [**Parquet**](#parquet) | `'parquet'` | 列射影プッシュダウン、統計情報フィルタリング、物理スキーマ検証 | 対応 |
| [**CSV**](#csv) | `'csv'` | 区切り文字、ヘッダー、エンコーディング等の設定 | 対応 |
| [**JSON**](#json) | `'json'` | NDJSON や JSON 配列の読み込み | 対応 |
| [**XLSX**](#xlsx) | `'xlsx'` | Excel ワークブックのシート名指定、セル範囲指定 | 単一ファイルのみ |

---

## Parquet

Parquet スキャナは、Parquet ファイルの物理メタデータから列射影やフィルタプッシュダウンを行います。`options` は空のオブジェクト `{}` を指定します。

```js
scanner: {
  type: 'parquet',
  options: {},
}
```

カタログは、Parquet ファイル内の物理スキーマ（列数、順序、列名、データ型）が、公開された `columns` メタデータと一致しているかを自動的に検証します。

### カラム型

Column には reference に記載された scalar type に加え、再帰的にネストした `JSON`、`STRUCT`、`LIST` を指定できます。

```js
columns: [
  { name: 'raw', type: 'JSON', nullable: true },
  { name: 'profile', type: 'STRUCT(name VARCHAR, tags VARCHAR[])', nullable: true },
  { name: 'items', type: 'LIST(STRUCT(id BIGINT, payload JSON))', nullable: true },
]
```

- `STRUCT` の field 名は重複できません。
- `LIST(type)` と `type[]` は同じ意味です。
- ネストは 32 階層までです。

---

## CSV

CSV table では DuckDB の `read_csv` scanner を使い、catalog の `columns` metadata を read schema にします。`auto_detect`（既定 `true`）は dialect と header を sniff し、`false` は宣言した dialect を使います。

```js
scanner: {
  type: 'csv',
  options: {
    delimiter: ',',
    header: true,
  },
}
```

省略した option には DuckDB の既定値が使われます。

### CSV options

| Option | 使用できる値 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `auto_detect` | `true` / `false` | `true` | 区切り文字やheaderを自動検出します。 |
| `header` | `true` / `false` | 自動検出時は検出、それ以外は`false` | 先頭行をheaderとして扱います。 |
| `delimiter` | NULを含まない空でない文字列。最大4 byte。`\t`も指定可能 | `,` | フィールドの区切り文字です。 |
| `quote` | NULを含まない0〜1 byteの文字列 | `"` | 引用符です。 |
| `escape` | NULを含まない0〜1 byteの文字列 | DuckDBの既定値 | エスケープ文字です。 |
| `comment` | NULを含まない0〜1 byteの文字列 | なし | コメント行を示す文字です。 |
| `skip` | 0以上のsafe integer | `0` | 読み取り前に無視する行数です。 |
| `nullstr` | NULを含まない文字列、またはその配列 | `""` | `NULL`として読み取る値です。 |
| `dateformat` | `auto`、またはNULを含まない`strptime`形式の文字列 | 自動 | `DATE`の形式です。 |
| `timestampformat` | `auto`、またはNULを含まない`strptime`形式の文字列 | 自動 | timestampの形式です。 |
| `compression` | `auto` / `infer`、`uncompressed` / `none`、`gzip`、`zstd` | 自動検出 | 圧縮形式です。 |
| `ignore_errors` | `true` / `false` | `false` | 不正な行を無視します。 |
| `null_padding` | `true` / `false` | `false` | 値が不足している行を`NULL`で補完します。 |
| `allow_quoted_nulls` | `true` / `false` | `true` | 引用符で囲まれたnull markerを`NULL`として扱います。 |
| `buffer_size` | 正のsafe integer。`max_line_size`も指定する場合はその値以上 | DuckDBが算出 | 読み取りbufferのbyte数です。 |
| `decimal_separator` | `.`または`,` | `.` | 小数点記号です。 |
| `encoding` | `utf-8`、`utf-16`、`latin-1`。extensionにより追加可能 | `utf-8` | 入力encodingです。 |
| `force_not_null` | 空でないcolumn名または`*`の配列。NUL不可 | なし | 指定したcolumnではnull markerを文字列として保持します。 |
| `max_line_size` | 0以上のsafe integer | `2,000,000` byte | 1行の最大byte数です。 |
| `new_line` | `\n`、`\r`、`\r\n` | 自動検出 | 改行文字です。 |
| `parallel` | `true` / `false` | `true` | 並列読み取りを有効にします。 |
| `sample_size` | `-1`、または正のsafe integer | `20,480`行 | 自動検出に使う行数です。`-1`は全行を表します。 |
| `strict_mode` | `true` / `false` | `true` | 不正なCSVをエラーにします。 |
| `thousands` | NULを含まない0〜1 byteの文字列 | なし | 桁区切り文字です。 |

- Schema option（`columns`、`names`、`types`、`column_types`、`auto_type_candidates`）は catalog の `columns` metadata で指定します。`all_varchar` と `normalize_names` は受け付けません。
- 仮想/partition、reject 出力、`union_by_name`、file sniffing 制御、DuckDB alias、COPY 専用 option は未対応です。

---

## JSON

JSON tableではDuckDBの`read_json` scannerを使い、catalogの`columns` metadataをread schemaにします。

```js
scanner: {
  type: 'json',
  options: {
    format: 'newline_delimited',
    records: 'true',
  },
}
```

省略したoptionにはDuckDBの既定値が使われます。

### JSON options

| Option | 使用できる値 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `format` | `auto`、`array`、`newline_delimited`、`unstructured` | `auto` | JSONの配置形式です。 |
| `compression` | `auto_detect`、`uncompressed`、`gzip`、`zstd` | 自動検出 | 圧縮形式です。 |
| `records` | 文字列の`auto`、`true`、`false` | `auto` | objectを行として読み取るか指定します。`false`ではcolumnを1つだけ定義します。 |
| `ignore_errors` | `true` / `false`。`newline_delimited`の場合のみ指定可能 | `false` | 不正なrecordを無視します。 |
| `maximum_object_size` | 1〜`4,294,967,295`のsafe integer | `16,777,216` byte | JSON objectの最大byte数です。 |
| `dateformat` | `iso`、またはNULを含まない`strptime`形式の文字列 | `iso` | `DATE`の形式です。 |
| `timestampformat` | `iso`、またはNULを含まない`strptime`形式の文字列 | `iso` | timestampの形式です。 |

- `columns`はcatalog metadataから渡します。Schema推論用optionは受け付けません。
- 仮想/partition column、`union_by_name`、alias、COPY専用optionは未対応です。

---

## XLSX

XLSXではDuckDBの`read_xlsx`を使います。1つのテーブルに指定できるファイルは1つだけです。`.xlsx`に対応し、古い`.xls`には対応しません。

```js
scanner: {
  type: 'xlsx',
  options: {
    sheet: 'Data',
    header: true,
  },
}
```

検出された列の名前と順序は、catalogの`columns`と一致する必要があります。値は読み取り時にcatalogで指定した型へ変換されます。省略したoptionにはDuckDBの既定値が使われます。

### XLSX options

| Option | 使用できる値 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `header` | `true` / `false` | 自動検出 | 先頭行を列名として扱います。 |
| `sheet` | NULを含まない空でない文字列 | 最初のシート | シート名です。 |
| `range` | NULを含まない空でない文字列 | 自動検出 | DuckDB形式のセル範囲です。 |
| `all_varchar` | `true` / `false` | `false` | すべての列を`VARCHAR`として読み取ってからcatalogの型へ変換します。 |
| `ignore_errors` | `true` / `false` | `false` | 型変換できない値を`NULL`にします。 |
| `stop_at_empty` | `true` / `false` | `true`。`range`指定時は`false` | 空の行で読み取りを止めます。 |
| `empty_as_varchar` | `true` / `false` | `false` | 空の列を`VARCHAR`として推論します。 |

列名はcatalogで定義するため、`normalize_names`は指定できません。
