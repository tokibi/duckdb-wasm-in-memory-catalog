---
title: Guides
description: Common workflows for publishing, updating, querying, and operating an in-memory catalog.
---

# Guides

## Publish application-owned datasets

Treat your application data model as the source of truth. Build a complete snapshot from that model and publish it through the controller instead of replaying DDL into DuckDB.

A typical application keeps metadata such as dataset names, columns, file locations, and content versions in its own state. Convert that state into the catalog snapshot shape at the boundary:

```js
function toCatalogSnapshot(datasets) {
  return {
    format_version: 2,
    schemas: [
      {
        name: 'main',
        tables: datasets.map((dataset) => ({
          name: dataset.name,
          snapshot: dataset.contentVersion,
          scanner: { type: 'parquet', options: {} },
          columns: dataset.columns,
          files: dataset.files.map((file) => ({ uri: file.url })),
        })),
      },
    ],
  }
}
```

This keeps catalog synchronization declarative: the latest application state becomes the latest catalog state.

## Update a catalog

Publish a complete replacement snapshot:

```js
await catalog.publishSnapshot(nextSnapshot)
```

The controller copies the input at call time and publishes snapshots in call order. A successfully validated snapshot atomically replaces the complete catalog state. Discard stale results from asynchronous application work before publishing them.

Change each table's `snapshot` only when that table's bytes or physical Parquet schema changes.

## Query a catalog

Tables are addressed with normal DuckDB catalog, schema, and table qualification:

```sql
SELECT category, count(*)
FROM app.analytics.events
GROUP BY category;
```

You can also select a default catalog and schema for shorter queries:

```js
await catalog.connection.query('USE app.analytics')
```

```sql
SELECT * FROM events;
```

Catalog mutation statements are rejected. The host application remains the metadata authority.

## Use remote files

`files[].uri` is a location, not a format declaration. For HTTP(S) files, configure DuckDB-Wasm's filesystem so it can reach the remote resource. The current scanner supports Parquet only.

The extension keeps the metadata URI unchanged but derives a DuckDB-facing scan URI using the table snapshot. URL fragments are not sent to the HTTP server, so gateways and Service Workers continue to receive the original base URI.

If the same remote URI can change contents, serialize publication of the new table snapshot with queries reading that table. A query must not span a content-changing update. For concurrent reads across versions, expose an observable immutable version in the path or query string.

## Inspect diagnostics

```js
const diagnostics = await catalog.diagnostics()
console.log(diagnostics)
```

Diagnostics are useful when confirming the Worker-side workspace state after publication or while investigating metadata failures.

## Recover from uncertain cleanup

Provide `onRecoveryRequired` if the application needs to react when controller cleanup cannot determine whether the Worker-side state was dropped successfully.

```js
const catalog = await InMemoryCatalogController.initialize(
  db,
  worker,
  {
    workspaceId,
    catalogName: 'app',
    extensionName,
    onRecoveryRequired({ workspaceId }) {
      console.error('Catalog runtime must be recreated', workspaceId)
    },
  },
  snapshot,
)
```

When recovery is required, recreate the affected runtime instead of assuming the previous workspace is safe to reuse.
