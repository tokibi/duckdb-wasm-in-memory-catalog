import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const extensionSource = await readFile(
  new URL('../../src/in_memory_catalog_extension.cpp', import.meta.url),
  'utf8',
)

function scanInternalSource() {
  const start = extensionSource.indexOf('void ScanInternal(')
  const end = extensionSource.indexOf('\n\toptional_ptr<CatalogEntry> GetCurrentEntry', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return extensionSource.slice(start, end)
}

describe('In-Memory Catalog schema scan contract', () => {
  it('includes views in context-aware table scans and dedicated view scans', () => {
    const scan = scanInternalSource()
    assert.match(
      scan,
      /if \(type == CatalogType::TABLE_ENTRY\) \{[\s\S]*ListQueryVisibleTables\(workspace, \*revision, schema_name\)[\s\S]*if \(context\) \{[\s\S]*ListQueryVisibleViews\(workspace, \*revision, schema_name\)[\s\S]*\}\s*\} else if \(type == CatalogType::VIEW_ENTRY && context\) \{[\s\S]*ListQueryVisibleViews\(workspace, \*revision, schema_name\)/,
    )
  })

  it('binds JSON through the loaded public table function without linking JSON internals', () => {
    assert.match(extensionSource, /scanner\.type == "json" \? "read_json"/)
    assert.match(extensionSource, /scanner\.type == "json" \|\| scanner\.type == "xlsx"[\s\S]*function\.bind\(context, input/)
    assert.match(extensionSource, /RC_JSON_SCHEMA_MISMATCH/)
    assert.doesNotMatch(extensionSource, /json_multi_file_info\.hpp/)
    assert.doesNotMatch(extensionSource, /JSONMultiFileInfo/)
  })

  it('binds XLSX through read_xlsx and validates catalog column names', () => {
    assert.match(extensionSource, /scanner\.type == "xlsx" \? "read_xlsx"/)
    assert.match(extensionSource, /scanner\.type == "xlsx" \? LogicalType::VARCHAR/)
    assert.match(extensionSource, /RC_XLSX_SCHEMA_MISMATCH/)
    assert.doesNotMatch(extensionSource, /xlsx_reader\.hpp|XLSXReader/)
  })
})
