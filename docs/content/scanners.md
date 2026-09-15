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
