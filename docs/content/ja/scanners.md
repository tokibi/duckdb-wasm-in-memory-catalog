---
title: Scanner
description: Catalog が受け付ける Parquet と CSV scanner の設定方法。
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

## CSV

CSV table では DuckDB の `read_csv` scanner を使います。公開されている `columns` metadata は CSV の read schema として渡されます。自動検出を有効にすると、DuckDB は file の内容から dialect と header を検出し、その schema に対して値を検証します。`auto_detect: false` にすると、宣言した dialect を sniffing なしで使います。

```js
scanner: {
  type: 'csv',
  options: {
    delimiter: ',',
    header: true,
  },
}
```

省略した option には DuckDB の既定値が使われます。Catalog は DuckDB に渡す前に option 名と JavaScript の値の型を検証します。文字列 option は NUL を含まない空でない文字列である必要がありますが、`nullstr` は空文字列または文字列配列も指定できます。配列 option は各要素を検証します。delimiter、quote、escape、comment、compression、encoding、newline、date format の構文は、table の bind 時に DuckDB が検証します。

### CSV options

| Option | 型 | 既定の動作 | 許容値・制約 | 意味 |
| --- | --- | --- | --- | --- |
| `auto_detect` | `boolean` | `true` | Boolean | CSV の dialect と型を file から検出します。`false` の場合、型検出を行わず、公開されている `columns` metadata を read schema として使います。 |
| `header` | `boolean` | `auto_detect: true` では自動判定、それ以外では `false` | Boolean | 先頭の CSV row が header かどうかを指定します。`true` の場合、bind 時に DuckDB が header と公開されている column 名の照合ルールを適用します。 |
| `delimiter` | `string` | `,` | Catalog 境界では NUL を含まない空でない文字列。delimiter の構文は DuckDB が検証 | Field の区切り文字。API 内では DuckDB の `delim` option に変換されます。 |
| `quote` | `string` | `"` | Catalog 境界では NUL を含まない空でない文字列。quote の構文は DuckDB が検証 | Quoted field の quote 文字または文字列。 |
| `escape` | `string` | `"` | Catalog 境界では NUL を含まない空でない文字列。escape の構文は DuckDB が検証 | Quoted field 内の escape に使う文字または文字列。 |
| `comment` | `string` | Comment なし | Catalog 境界では NUL を含まない空でない文字列。comment の構文は DuckDB が検証 | Comment 行を示す文字または文字列。 |
| `skip` | `number` | `0` | JavaScript の 0 以上の safe integer | CSV を読み始める前に skip する row 数。 |
| `nullstr` | `string` または `string[]` | 空の field は NULL | NUL を含まない文字列またはその配列。この option では空文字列も指定可能。値は DuckDB が検証 | `NULL` として読む文字列。 |
| `dateformat` | `string` | DuckDB の date format | Catalog 境界では NUL を含まない空でない文字列。format は DuckDB が検証 | `DATE` 値に使う `strptime` format。 |
| `timestampformat` | `string` | DuckDB の timestamp format | Catalog 境界では NUL を含まない空でない文字列。format は DuckDB が検証 | Timestamp 値に使う `strptime` format。 |
| `compression` | `string` | `AUTO_DETECT` | Catalog 境界では NUL を含まない空でない文字列。compression 名は DuckDB が検証 | CSV の compression。`auto_detect`、`uncompressed`、`gzip`、`zstd` などを指定できます。 |
| `ignore_errors` | `boolean` | `false` | Boolean | DuckDB が invalid と判定した CSV row を無視します。 |
| `null_padding` | `boolean` | `false` | Boolean | schema より field 数が少ない row を `NULL` で補います。 |
| `allow_quoted_nulls` | `boolean` | `true` | Boolean | Quoted null marker を `NULL` として扱います。 |
| `buffer_size` | `number` | DuckDB が決める buffer size | 1 以上の JavaScript safe integer。実効値は DuckDB が検証し、`max_line_size` 以上である必要があります | CSV reader の buffer size（byte）。 |
| `decimal_separator` | `string` | `.` | Catalog 境界では NUL を含まない空でない文字列。separator の構文は DuckDB が検証 | 数値の小数点記号。 |
| `encoding` | `string` | `utf-8` | Catalog 境界では NUL を含まない空でない文字列。encoding は DuckDB が検証 | file の文字 encoding。 |
| `force_not_null` | `string[]` | 強制する column なし | NUL を含まない空でない文字列の配列。column 名は DuckDB が検証 | null marker を文字列のままにする column。 |
| `max_line_size` | `number` | 2,000,000 byte | 1 以上の JavaScript safe integer。実効値は DuckDB が検証 | CSV 1 行の最大 size。 |
| `new_line` | `string` | newline を検出または既定値 | DuckDB の bind では `\n`、`\r`、`\r\n` のいずれか。Catalog 境界では NUL を含まない空でない文字列 | record を分割する newline sequence。 |
| `parallel` | `boolean` | `true` | Boolean | CSV parsing の並列化を許可します。 |
| `sample_size` | `number` | 20,480 row | `-1` または 1 以上の safe integer。`-1` は入力全体を sample。sampling の規則は DuckDB が適用 | CSV 検出に使う row 数。 |
| `strict_mode` | `boolean` | `true` | Boolean | 有効時は malformed CSV row を拒否します。 |
| `thousands` | `string` | thousands separator なし | Catalog 境界では NUL を含まない空でない文字列。separator の構文は DuckDB が検証 | 数値の thousands separator。 |

Catalog API が受け付ける option はこの表にあるものだけです。`columns`、`names`、`types`、`column_types` などの schema option は table の `columns` metadata で表現し、固定 schema では `auto_type_candidates` も不要です。仮想 column・partition option（`filename`、`hive_partitioning`）、reject 出力 option（`store_rejects`、`rejects_*`）、`union_by_name`、file sniffing 制御は、固定 schema と衝突するか scanner の副作用を導入するため受け付けません。`all_varchar` と `normalize_names` も、Catalog が常に column 名と型を渡すため受け付けません。公開名は `delimiter` と `max_line_size` で、DuckDB の alias（`sep`、`maximum_line_size`）や COPY 専用 option は受け付けません。その他の DuckDB `read_csv` option も `scanner.options` には指定できません。
