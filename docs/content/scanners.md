---
title: Scanners
description: Configure the Parquet and CSV scanners accepted by the catalog.
---

# Scanners

Each catalog table declares one scanner. The catalog does not infer a scanner from a filename, extension, or URI. The scanner configuration is table-level, so every file in one table uses the same configuration.

## Parquet

Parquet tables use an empty options object:

```js
scanner: {
  type: 'parquet',
  options: {},
}
```

The catalog checks the physical Parquet column count, order, names, and types against the published `columns` metadata.

## CSV

CSV tables use DuckDB's `read_csv` scanner. The published `columns` metadata is supplied as the CSV read schema. With automatic detection enabled, DuckDB still sniffs the dialect and header from the file, then validates values against that schema. Set `auto_detect: false` when the declared dialect should be used without sniffing.

```js
scanner: {
  type: 'csv',
  options: {
    delimiter: ',',
    header: true,
  },
}
```

If an option is omitted, DuckDB's default is used. The catalog validates the option name and JavaScript value type before passing it to DuckDB. For string options, the catalog requires a non-empty string without NUL characters; `nullstr` may additionally be an empty string or an array of strings. Array options are validated element by element. Delimiter, quote, escape, comment, compression, encoding, newline, and date-format syntax are validated by DuckDB when the table is bound.

### CSV options

| Option | Type | Default behavior | Allowed values and constraints | Meaning |
| --- | --- | --- | --- | --- |
| `auto_detect` | `boolean` | `true` | Boolean | Detect the CSV dialect and types from the file. When `false`, the published `columns` metadata supplies the read schema without type detection. |
| `header` | `boolean` | Automatic when `auto_detect` is `true`; otherwise `false` | Boolean | Whether the first CSV row is a header. When set to `true`, DuckDB uses the header while binding and applies its header matching rules to the published column names. |
| `delimiter` | `string` | `,` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates delimiter syntax | Field separator. The API maps this option to DuckDB's `delim` option. |
| `quote` | `string` | `"` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates quote syntax | Quote character or sequence. |
| `escape` | `string` | `"` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates escape syntax | Escape character or sequence used inside quoted fields. |
| `comment` | `string` | No comment character | Non-empty, NUL-free string at the catalog boundary; DuckDB validates comment syntax | Character or sequence that marks a comment line. |
| `skip` | `number` | `0` | Non-negative safe integer in JavaScript | Number of rows to skip before reading the CSV. |
| `nullstr` | `string` or `string[]` | Empty fields are NULL | String or array of NUL-free strings; an empty string is allowed for this option; DuckDB validates the value | One or more texts that should be read as `NULL`. |
| `dateformat` | `string` | DuckDB default date format | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the format | `strptime` format used for `DATE` values. |
| `timestampformat` | `string` | DuckDB default timestamp format | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the format | `strptime` format used for timestamp values. |
| `compression` | `string` | `AUTO_DETECT` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the compression name | Compression method for the CSV file, such as `auto_detect`, `uncompressed`, `gzip`, or `zstd`. |
| `ignore_errors` | `boolean` | `false` | Boolean | Ignore CSV rows that DuckDB identifies as invalid. |
| `null_padding` | `boolean` | `false` | Boolean | Pad rows with fewer fields than the schema with `NULL` values. |
| `allow_quoted_nulls` | `boolean` | `true` | Boolean | Treat quoted null markers as `NULL`. |
| `buffer_size` | `number` | DuckDB-derived buffer size | Positive JavaScript safe integer; DuckDB validates the effective size and requires it to cover `max_line_size` | CSV reader buffer size in bytes. |
| `decimal_separator` | `string` | `.` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates separator syntax | Decimal separator for numeric values. |
| `encoding` | `string` | `utf-8` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the encoding | Character encoding used to decode the file. |
| `force_not_null` | `string[]` | No forced columns | Array of non-empty, NUL-free strings; DuckDB validates column names | Columns whose null markers must remain strings. |
| `max_line_size` | `number` | `2,000,000` bytes | Positive JavaScript safe integer; DuckDB validates the effective size | Maximum CSV line size. |
| `new_line` | `string` | Detected/default newline | One of `\n`, `\r`, or `\r\n` at DuckDB bind; the catalog checks only non-empty, NUL-free string | Newline sequence used to split records. |
| `parallel` | `boolean` | `true` | Boolean | Allow parallel CSV parsing. |
| `sample_size` | `number` | `20,480` rows | `-1` or a positive JavaScript safe integer; `-1` samples the entire input; DuckDB applies its sampling rules | Number of rows used for CSV detection. |
| `strict_mode` | `boolean` | `true` | Boolean | Reject malformed CSV rows when enabled. |
| `thousands` | `string` | No thousands separator | Non-empty, NUL-free string at the catalog boundary; DuckDB validates separator syntax | Thousands separator for numeric values. |

The catalog API accepts only the options in this table. `columns`, `names`, `types`, `column_types`, and related schema options are represented by the table's published `columns` metadata; `auto_type_candidates` is unnecessary with that fixed schema. Virtual-column and partition options (`filename`, `hive_partitioning`), reject-output options (`store_rejects` and `rejects_*`), `union_by_name`, and file-sniffing controls are intentionally not accepted because they conflict with the fixed catalog schema or introduce scanner side effects. `all_varchar` and `normalize_names` are also omitted because the catalog always supplies column names and types. The public names are `delimiter` and `max_line_size`; DuckDB aliases such as `sep` and `maximum_line_size`, and COPY-only options, are not accepted. Other DuckDB `read_csv` parameters cannot be supplied through `scanner.options`.
