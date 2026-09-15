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

CSV tables use DuckDB's `read_csv` scanner. The published `columns` metadata is supplied as the CSV read schema. With automatic detection enabled, DuckDB uses the file contents to detect the dialect and validates the header and values against that schema.

```js
scanner: {
  type: 'csv',
  options: {
    delimiter: ',',
    header: true,
  },
}
```

If an option is omitted, DuckDB's default is used. The catalog validates the option name and JavaScript value type before passing it to DuckDB. For string options, the catalog only requires a non-empty string without NUL characters; delimiter, quote, escape, comment, compression, and date-format syntax are validated by DuckDB when the table is bound.

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
| `nullstr` | `string` | Empty fields are NULL | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the value | Text that should be read as `NULL`. |
| `all_varchar` | `boolean` | `false` | Boolean | Read all detected CSV columns as `VARCHAR` before applying the catalog schema. |
| `normalize_names` | `boolean` | `false` | Boolean | Normalize automatically detected column names. |
| `dateformat` | `string` | DuckDB default date format | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the format | `strptime` format used for `DATE` values. |
| `timestampformat` | `string` | DuckDB default timestamp format | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the format | `strptime` format used for timestamp values. |
| `compression` | `string` | `AUTO_DETECT` | Non-empty, NUL-free string at the catalog boundary; DuckDB validates the compression name | Compression method for the CSV file, such as `auto_detect`, `uncompressed`, `gzip`, or `zstd`. |
| `ignore_errors` | `boolean` | `false` | Boolean | Ignore CSV rows that DuckDB identifies as invalid. |
| `null_padding` | `boolean` | `false` | Boolean | Pad rows with fewer fields than the schema with `NULL` values. |

The catalog API accepts only the options in this table. Other DuckDB `read_csv` options, including `columns` and `column_types`, are reserved for the catalog's published `columns` metadata and cannot be supplied through `scanner.options`.
