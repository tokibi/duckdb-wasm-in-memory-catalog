---
title: Scanner
description: Catalog が受け付ける Parquet、CSV、JSON scanner の設定方法。
---

# Scanner

各 catalog table は scanner を1つ明示します。Catalog は filename、extension、URI から scanner を推論しません。1つの table に含まれるすべての file は同じ scanner 設定を使います。

## Parquet

Parquet table の options は空 object にします。

```js
scanner: {
  type: 'parquet',
  options: {},
}
```

Catalog は physical Parquet の column 数、順序、名前、型を、公開されている `columns` metadata と照合します。

## Column type

Columnにはreferenceに記載されたscalar typeに加え、再帰的にネストした`JSON`、`STRUCT`、`LIST`を指定できます。

```js
columns: [
  { name: 'raw', type: 'JSON', nullable: true },
  { name: 'profile', type: 'STRUCT(name VARCHAR, tags VARCHAR[])', nullable: true },
  { name: 'items', type: 'LIST(STRUCT(id BIGINT, payload JSON))', nullable: true },
]
```

`STRUCT`のfield名は重複できません。`LIST(type)`と`type[]`は同じ意味です。ネストは32階層までです。

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

省略した option には DuckDB の既定値が使われます。`Catalog value` は bridge 前の検証、`DuckDB value` は bind 時に DuckDB 1.4 が受け付ける値を示します。

### CSV options

| Option | Catalog value | DuckDB value | Default | Description |
| --- | --- | --- | --- | --- |
| `auto_detect` | `boolean` | `true` / `false` | `true` | dialect と header を sniff。`false` は catalog schema を sniff なしで使用。 |
| `header` | `boolean` | `true` / `false` | `auto_detect=true` は sniff、それ以外は `false` | 先頭 row を header として扱う。 |
| `delimiter` | 空でない文字列、NUL なし | 最大4 byte、`\t` は展開 | `,` | Field 区切り。DuckDB `delim` に変換。 |
| `quote` | 文字列、NUL なし。空可 | 0 または1 byte | `"` | Quote 文字。 |
| `escape` | 文字列、NUL なし。空可 | 0 または1 byte | DuckDB 既定値 | Escape 文字。 |
| `comment` | 文字列、NUL なし。空可 | 0 または1 byte | なし | Comment 行の文字。 |
| `skip` | 0 以上の safe integer | integer `>= 0` | `0` | 読み取り前に skip する row 数。 |
| `nullstr` | string または string[]、NUL なし | string または string[]、NULL 要素なし | `""` | `NULL` とする値。 |
| `dateformat` | 空でない文字列、NUL なし | `auto` または `strptime` format | Auto | `DATE` 用 format。 |
| `timestampformat` | 空でない文字列、NUL なし | `auto` または `strptime` format | Auto | Timestamp 用 format。 |
| `compression` | 空でない文字列、NUL なし | `auto` / `infer`、`uncompressed` / `none`、`gzip`、`zstd` | Auto-detect | CSV compression。 |
| `ignore_errors` | `boolean` | `true` / `false` | `false` | Invalid row を無視。 |
| `null_padding` | `boolean` | `true` / `false` | `false` | 短い row を `NULL` で補完。 |
| `allow_quoted_nulls` | `boolean` | `true` / `false` | `true` | Quoted null marker を `NULL` にする。 |
| `buffer_size` | 正の safe integer | integer `> 0`。両方指定時は `max_line_size` 以上 | DuckDB が算出 | Reader buffer size（byte）。 |
| `decimal_separator` | 空でない文字列、NUL なし | `.` または `,` | `.` | 小数点記号。 |
| `encoding` | 空でない文字列、NUL なし | Core は `utf-8`、`utf-16`、`latin-1`。拡張で追加可 | `utf-8` | 入力 encoding。 |
| `force_not_null` | 空でない string[]、NUL なし | Column 名または `*` | なし | 選択 column の null marker を文字列に保持。 |
| `max_line_size` | 0 以上の safe integer | integer `>= 0` | `2,000,000` byte | 1行の最大 size。 |
| `new_line` | 空でない文字列、NUL なし | `\n`、`\r`、または `\r\n` | Sniff/既定値 | Record separator。 |
| `parallel` | `boolean` | `true` / `false` | `true` | 並列 parsing を許可。 |
| `sample_size` | `-1` または正の safe integer | `-1` または integer `>= 1` | 20,480 row | 検出に使う row 数。`-1` は全体。 |
| `strict_mode` | `boolean` | `true` / `false` | `true` | Malformed row を拒否。 |
| `thousands` | 文字列、NUL なし。空可 | 0 または1 byte | なし | Thousands separator。 |

- Schema option（`columns`、`names`、`types`、`column_types`、`auto_type_candidates`）は catalog の `columns` metadata で指定します。`all_varchar` と `normalize_names` は受け付けません。
- 仮想/partition、reject 出力、`union_by_name`、file sniffing 制御、DuckDB alias、COPY 専用 option は未対応です。

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

| Option | Catalog value | DuckDB value | Default | Description |
| --- | --- | --- | --- | --- |
| `format` | `auto`、`array`、`newline_delimited`、`unstructured` | 同左。DuckDBは`nd` aliasも受付 | `auto` | JSON documentの配置形式。 |
| `compression` | 空でない文字列、NULなし | `auto_detect`、`uncompressed`、`gzip`、`zstd` | Auto-detect | Input compression。 |
| `records` | 文字列の`auto`、`true`、`false` | 同左 | `auto` | Objectをrowとして読む。`false`ではcatalog columnが1つ必要。 |
| `ignore_errors` | `boolean` | `true` / `false`。newline-delimited JSONのみ | `false` | Malformed recordを無視。 |
| `maximum_object_size` | `4,294,967,295`以下の正のsafe integer | 正の`UINTEGER` | `16,777,216` byte | JSON objectの最大size。 |
| `dateformat` | 空でない文字列、NULなし | `iso`または`strptime` format | ISO | `DATE`用format。 |
| `timestampformat` | 空でない文字列、NULなし | `iso`または`strptime` format | ISO | Timestamp用format。 |

- `columns`はcatalog metadataから渡します。Schema推論用optionは受け付けません。
- 仮想/partition column、`union_by_name`、alias、COPY専用optionは未対応です。
