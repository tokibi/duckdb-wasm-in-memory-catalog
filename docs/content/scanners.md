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

If an option is omitted, DuckDB's default is used.

### CSV options

| Option | Accepted value | Default | Description |
| --- | --- | --- | --- |
| `auto_detect` | `true` / `false` | `true` | Detect the dialect and header. |
| `header` | `true` / `false` | Sniffed with auto-detection; otherwise `false` | Treat the first row as a header. |
| `delimiter` | Non-empty string without NUL; up to 4 bytes; `\t` is accepted | `,` | Field separator. |
| `quote` | 0- or 1-byte string without NUL | `"` | Quote character. |
| `escape` | 0- or 1-byte string without NUL | DuckDB default | Escape character. |
| `comment` | 0- or 1-byte string without NUL | None | Comment-line character. |
| `skip` | Non-negative safe integer | `0` | Rows skipped before reading. |
| `nullstr` | String or string array without NUL | `""` | Values read as `NULL`. |
| `dateformat` | `auto` or a `strptime` format without NUL | Auto | Format for `DATE` values. |
| `timestampformat` | `auto` or a `strptime` format without NUL | Auto | Format for timestamp values. |
| `compression` | `auto` / `infer`, `uncompressed` / `none`, `gzip`, `zstd` | Auto-detect | Input compression. |
| `ignore_errors` | `true` / `false` | `false` | Ignore invalid rows. |
| `null_padding` | `true` / `false` | `false` | Pad short rows with `NULL`. |
| `allow_quoted_nulls` | `true` / `false` | `true` | Treat quoted null markers as `NULL`. |
| `buffer_size` | Positive safe integer; at least `max_line_size` when both are set | DuckDB-derived | Reader buffer size in bytes. |
| `decimal_separator` | `.` or `,` | `.` | Decimal separator. |
| `encoding` | `utf-8`, `utf-16`, `latin-1`; extensions may add values | `utf-8` | Input encoding. |
| `force_not_null` | Non-empty array of column names or `*`, without NUL | None | Keep null markers as strings for selected columns. |
| `max_line_size` | Non-negative safe integer | `2,000,000` bytes | Maximum line size. |
| `new_line` | `\n`, `\r`, or `\r\n` | Auto-detect | Record separator. |
| `parallel` | `true` / `false` | `true` | Enable parallel parsing. |
| `sample_size` | `-1` or a positive safe integer | `20,480` rows | Rows used for detection; `-1` means all input. |
| `strict_mode` | `true` / `false` | `true` | Reject malformed CSV rows. |
| `thousands` | 0- or 1-byte string without NUL | None | Thousands separator. |

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

| Option | Accepted value | Default | Description |
| --- | --- | --- | --- |
| `format` | `auto`, `array`, `newline_delimited`, or `unstructured` | `auto` | JSON document layout. |
| `compression` | `auto_detect`, `uncompressed`, `gzip`, or `zstd` | Auto-detect | Input compression. |
| `records` | String value `auto`, `true`, or `false` | `auto` | Whether objects are read as rows; `false` requires exactly one column. |
| `ignore_errors` | `true` / `false`; only valid with `newline_delimited` | `false` | Skip malformed records. |
| `maximum_object_size` | Safe integer from 1 to `4,294,967,295` | `16,777,216` bytes | Maximum JSON object size. |
| `dateformat` | `iso` or a `strptime` format without NUL | `iso` | Format for `DATE` values. |
| `timestampformat` | `iso` or a `strptime` format without NUL | `iso` | Format for timestamp values. |

- `columns` is supplied by the catalog metadata. Schema-inference options are not accepted.
- Virtual/partition columns, `union_by_name`, aliases, and COPY-only options are not supported.
