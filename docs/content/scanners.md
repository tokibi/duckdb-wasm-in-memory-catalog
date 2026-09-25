---
title: Scanners
description: Scanner configuration and option reference for Parquet, CSV, JSON, and XLSX.
---

# Scanners

Every catalog table must explicitly declare exactly one `scanner`. The catalog never infers scanner types from filenames, extensions, or URIs. All files within a single table share the same scanner configuration.

---

## Supported Scanners Overview

| Scanner | `type` | Key Highlights | Multiple Files |
|---|---|---|---|
| [**Parquet**](#parquet) | `'parquet'` | Fast projection pushdown, statistics filtering, physical schema validation | Supported |
| [**CSV**](#csv) | `'csv'` | Highly configurable delimiter, headers, date/time parsing, strict mode | Supported |
| [**JSON**](#json) | `'json'` | Supports NDJSON (newline-delimited) and JSON arrays | Supported |
| [**XLSX**](#xlsx) | `'xlsx'` | Excel workbook support with sheet and cell-range filtering | Single file only |

---

## Parquet

The Parquet scanner leverages DuckDB's native Parquet reader for high-performance column projection and statistics pushdown. `options` must be an empty object `{}`:

```js
scanner: {
  type: 'parquet',
  options: {},
}
```

The catalog verifies that the physical Parquet file schema (column count, ordering, names, and types) strictly matches the declared `columns` metadata.

### Column Types

Columns can be any scalar type documented in the reference, or recursively nested `` `JSON` ``, `` `STRUCT` ``, and `` `LIST` `` types.

```js
columns: [
  { name: 'raw', type: 'JSON', nullable: true },
  { name: 'profile', type: 'STRUCT(name VARCHAR, tags VARCHAR[])', nullable: true },
  { name: 'items', type: 'LIST(STRUCT(id BIGINT, payload JSON))', nullable: true },
]
```

- Field names in `` `STRUCT` `` cannot be duplicated.
- `` `LIST(type)` `` and `type[]` are interchangeable.
- Nesting is supported up to 32 levels deep.

---

## CSV

The CSV scanner uses DuckDB's `read_csv` engine with the catalog's `columns` metadata acting as the forced read schema. `auto_detect` (default `true`) sniffs dialects and headers; `false` uses declared dialect options.

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
| `auto_detect` | `true` / `false` | `true` | Sniff dialect and header settings. |
| `header` | `true` / `false` | Sniffed when auto-detecting; `false` otherwise | Treat the first row as column headers. |
| `delimiter` | Non-empty string up to 4 bytes without NUL; `\t` allowed | `,` | Field delimiter character. |
| `quote` | 0- or 1-byte string without NUL | `"` | Quoting character. |
| `escape` | 0- or 1-byte string without NUL | DuckDB default | Escape character. |
| `comment` | 0- or 1-byte string without NUL | None | Comment prefix character. |
| `skip` | Non-negative safe integer | `0` | Number of lines to skip from start. |
| `nullstr` | String or array of strings without NUL | `""` | String values to interpret as `NULL`. |
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

---

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

---

## XLSX

XLSX tables use DuckDB's `read_xlsx` scanner. Each table must contain exactly one `.xlsx` file; legacy `.xls` files are not supported.

```js
scanner: {
  type: 'xlsx',
  options: {
    sheet: 'Data',
    header: true,
  },
}
```

The detected column names and order must match the catalog `columns`. Values are cast to the catalog column types while scanning. If an option is omitted, DuckDB's default is used.

### XLSX options

| Option | Accepted value | Default | Description |
| --- | --- | --- | --- |
| `header` | `true` / `false` | Auto-detect | Treat the first row as column names. |
| `sheet` | Non-empty string without NUL | First sheet | Worksheet name. |
| `range` | Non-empty string without NUL | Auto-detect | Cell range in DuckDB spreadsheet notation. |
| `all_varchar` | `true` / `false` | `false` | Read every column as `VARCHAR` before casting to the catalog type. |
| `ignore_errors` | `true` / `false` | `false` | Convert values that cannot be cast to `NULL`. |
| `stop_at_empty` | `true` / `false` | `true`; `false` when `range` is set | Stop after an empty row. |
| `empty_as_varchar` | `true` / `false` | `false` | Infer an empty column as `VARCHAR`. |

`normalize_names` is not accepted because column names are defined by the catalog contract.
