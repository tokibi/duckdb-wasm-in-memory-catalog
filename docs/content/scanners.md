---
title: Scanners
description: Configure the Parquet, CSV, and JSON scanners accepted by the catalog.
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

## Column types

Columns accept the scalar types listed in the reference, plus recursively nested `JSON`, `STRUCT`, and `LIST` types.

```js
columns: [
  { name: 'raw', type: 'JSON', nullable: true },
  { name: 'profile', type: 'STRUCT(name VARCHAR, tags VARCHAR[])', nullable: true },
  { name: 'items', type: 'LIST(STRUCT(id BIGINT, payload JSON))', nullable: true },
]
```

`STRUCT` fields must have unique names. `LIST(type)` and `type[]` are equivalent. Nesting is limited to 32 levels.

## CSV

CSV tables use DuckDB's `read_csv` scanner with the catalog's `columns` metadata as the read schema. `auto_detect` (default `true`) sniffs the dialect and header; set it to `false` to use the declared dialect.

```js
scanner: {
  type: 'csv',
  options: {
    delimiter: ',',
    header: true,
  },
}
```

If an option is omitted, DuckDB's default is used. `Catalog value` describes validation before the bridge; `DuckDB value` describes what DuckDB 1.4 accepts at bind time.

### CSV options

| Option | Catalog value | DuckDB value | Default | Description |
| --- | --- | --- | --- | --- |
| `auto_detect` | `boolean` | `true` / `false` | `true` | Sniff dialect and header; `false` uses the catalog schema without sniffing. |
| `header` | `boolean` | `true` / `false` | Sniffed when `auto_detect=true`; otherwise `false` | Treat the first row as a header. |
| `delimiter` | Non-empty string, no NUL | Up to 4 bytes; `\t` is expanded | `,` | Field separator; mapped to DuckDB `delim`. |
| `quote` | String, no NUL; empty allowed | 0 or 1 byte | `"` | Quote character. |
| `escape` | String, no NUL; empty allowed | 0 or 1 byte | DuckDB default | Escape character. |
| `comment` | String, no NUL; empty allowed | 0 or 1 byte | None | Comment-line character. |
| `skip` | Non-negative safe integer | Integer `>= 0` | `0` | Rows skipped before reading. |
| `nullstr` | String or string[]; no NUL | String or string[]; no NULL elements | `""` | Values read as `NULL`. |
| `dateformat` | Non-empty string, no NUL | `auto` or a `strptime` format | Auto | Format for `DATE` values. |
| `timestampformat` | Non-empty string, no NUL | `auto` or a `strptime` format | Auto | Format for timestamp values. |
| `compression` | Non-empty string, no NUL | `auto` / `infer`, `uncompressed` / `none`, `gzip`, `zstd` | Auto-detect | CSV compression. |
| `ignore_errors` | `boolean` | `true` / `false` | `false` | Ignore invalid CSV rows. |
| `null_padding` | `boolean` | `true` / `false` | `false` | Pad short rows with `NULL`. |
| `allow_quoted_nulls` | `boolean` | `true` / `false` | `true` | Treat quoted null markers as `NULL`. |
| `buffer_size` | Positive safe integer | Integer `> 0`; must cover `max_line_size` when both are set | DuckDB-derived | Reader buffer size in bytes. |
| `decimal_separator` | Non-empty string, no NUL | `.` or `,` | `.` | Decimal separator. |
| `encoding` | Non-empty string, no NUL | Core: `utf-8`, `utf-16`, `latin-1`; extensions may add encodings | `utf-8` | Input character encoding. |
| `force_not_null` | Non-empty string[]; no NUL | Column names or `*` | None | Keep null markers as strings for selected columns. |
| `max_line_size` | Non-negative safe integer | Integer `>= 0` | `2,000,000` bytes | Maximum line size. |
| `new_line` | Non-empty string, no NUL | `\n`, `\r`, or `\r\n` | Sniffed/default | Record separator. |
| `parallel` | `boolean` | `true` / `false` | `true` | Enable parallel parsing. |
| `sample_size` | `-1` or positive safe integer | `-1` or integer `>= 1` | `20,480` rows | Rows used for detection; `-1` means all input. |
| `strict_mode` | `boolean` | `true` / `false` | `true` | Reject malformed CSV rows. |
| `thousands` | String, no NUL; empty allowed | 0 or 1 byte | None | Thousands separator. |

- Schema options (`columns`, `names`, `types`, `column_types`, `auto_type_candidates`) come from the catalog `columns` metadata. `all_varchar` and `normalize_names` are not accepted.
- Virtual/partition options, reject-output options, `union_by_name`, file-sniffing controls, DuckDB aliases, and COPY-only options are not supported.

## JSON

JSON tables use DuckDB's `read_json` scanner with the catalog's `columns` metadata as the read schema.

```js
scanner: {
  type: 'json',
  options: {
    format: 'newline_delimited',
    records: 'true',
  },
}
```

If an option is omitted, DuckDB's default is used.

### JSON options

| Option | Catalog value | DuckDB value | Default | Description |
| --- | --- | --- | --- | --- |
| `format` | `auto`, `array`, `newline_delimited`, or `unstructured` | Same; DuckDB also accepts the `nd` alias | `auto` | JSON document layout. |
| `compression` | Non-empty string, no NUL | `auto_detect`, `uncompressed`, `gzip`, or `zstd` | Auto-detect | Input compression. |
| `records` | `auto`, `true`, or `false` as a string | Same | `auto` | Read objects as rows; `false` requires exactly one catalog column. |
| `ignore_errors` | `boolean` | `true` / `false`; only valid for newline-delimited JSON | `false` | Skip malformed records. |
| `maximum_object_size` | Positive safe integer, at most `4,294,967,295` | Positive `UINTEGER` | `16,777,216` bytes | Maximum JSON object size. |
| `dateformat` | Non-empty string, no NUL | `iso` or a `strptime` format | ISO | Format for `DATE` values. |
| `timestampformat` | Non-empty string, no NUL | `iso` or a `strptime` format | ISO | Format for timestamp values. |

- `columns` is supplied by the catalog metadata. Schema-inference options are not accepted.
- Virtual/partition columns, `union_by_name`, aliases, and COPY-only options are not supported.
