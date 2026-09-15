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

CSV table では DuckDB の `read_csv` scanner を使います。公開されている `columns` metadata は CSV の read schema として渡されます。自動検出を有効にすると、DuckDB は file の内容から dialect を検出し、その schema に対して header と値を検証します。

```js
scanner: {
  type: 'csv',
  options: {
    delimiter: ',',
    header: true,
  },
}
```

省略した option には DuckDB の既定値が使われます。Catalog は DuckDB に渡す前に option 名と JavaScript の値の型を検証します。文字列 option について Catalog が検証するのは、NUL を含まない空でない文字列であることまでです。delimiter、quote、escape、comment、compression、date format の構文は、table の bind 時に DuckDB が検証します。

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
| `nullstr` | `string` | 空の field は NULL | Catalog 境界では NUL を含まない空でない文字列。値は DuckDB が検証 | `NULL` として読む文字列。 |
| `all_varchar` | `boolean` | `false` | Boolean | 検出した CSV column をすべて `VARCHAR` として読んでから、Catalog schema を適用します。 |
| `normalize_names` | `boolean` | `false` | Boolean | 自動検出した column 名を正規化します。 |
| `dateformat` | `string` | DuckDB の date format | Catalog 境界では NUL を含まない空でない文字列。format は DuckDB が検証 | `DATE` 値に使う `strptime` format。 |
| `timestampformat` | `string` | DuckDB の timestamp format | Catalog 境界では NUL を含まない空でない文字列。format は DuckDB が検証 | Timestamp 値に使う `strptime` format。 |
| `compression` | `string` | `AUTO_DETECT` | Catalog 境界では NUL を含まない空でない文字列。compression 名は DuckDB が検証 | CSV の compression。`auto_detect`、`uncompressed`、`gzip`、`zstd` などを指定できます。 |
| `ignore_errors` | `boolean` | `false` | Boolean | DuckDB が invalid と判定した CSV row を無視します。 |
| `null_padding` | `boolean` | `false` | Boolean | schema より field 数が少ない row を `NULL` で補います。 |

Catalog API が受け付ける option はこの表にあるものだけです。`columns` や `column_types` を含む他の DuckDB `read_csv` option は、Catalog が持つ `columns` metadata と役割が重複するため、`scanner.options` には指定できません。
