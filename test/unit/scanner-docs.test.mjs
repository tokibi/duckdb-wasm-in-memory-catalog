import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const [metadataSource, nativeSource, english, japanese, viteConfig] = await Promise.all([
  readFile(new URL('../../src/javascript/in-memory-catalog-metadata-store.js', import.meta.url), 'utf8'),
  readFile(new URL('../../src/in_memory_catalog_extension.cpp', import.meta.url), 'utf8'),
  readFile(new URL('../../docs/content/scanners.md', import.meta.url), 'utf8'),
  readFile(new URL('../../docs/content/ja/scanners.md', import.meta.url), 'utf8'),
  readFile(new URL('../../docs/vite.config.ts', import.meta.url), 'utf8'),
])

const csvOptions = [
  'auto_detect',
  'header',
  'delimiter',
  'quote',
  'escape',
  'comment',
  'skip',
  'nullstr',
  'dateformat',
  'timestampformat',
  'compression',
  'ignore_errors',
  'null_padding',
  'allow_quoted_nulls',
  'buffer_size',
  'decimal_separator',
  'encoding',
  'force_not_null',
  'max_line_size',
  'new_line',
  'parallel',
  'sample_size',
  'strict_mode',
  'thousands',
]

describe('Scanner documentation', () => {
  it('documents every CSV option accepted by the metadata store in both locales', () => {
    const optionsHeader = /\| Option \| Catalog value \| DuckDB value \| Default \| Description \|/
    assert.match(english, optionsHeader)
    assert.match(japanese, optionsHeader)
    for (const option of csvOptions) {
      assert.match(metadataSource, new RegExp(`\\b${option}:`))
      assert.match(nativeSource, new RegExp('"' + option + '"'))
      const optionRow = new RegExp('\\| `' + option + '` \\|')
      assert.match(english, optionRow)
      assert.match(japanese, optionRow)
    }
    assert.doesNotMatch(metadataSource, /\ball_varchar:/)
    assert.doesNotMatch(metadataSource, /\bnormalize_names:/)
    assert.doesNotMatch(nativeSource, /"all_varchar"/)
    assert.doesNotMatch(nativeSource, /"normalize_names"/)
    assert.doesNotMatch(english, /\| `all_varchar` \|/)
    assert.doesNotMatch(english, /\| `normalize_names` \|/)
    assert.doesNotMatch(japanese, /\| `all_varchar` \|/)
    assert.doesNotMatch(japanese, /\| `normalize_names` \|/)
  })

  it('exposes the dedicated scanner page in the documentation navigation', () => {
    assert.match(english, /type: 'parquet'/)
    assert.match(english, /type: 'csv'/)
    assert.match(japanese, /type: 'parquet'/)
    assert.match(japanese, /type: 'csv'/)
    assert.match(viteConfig, /link: '\/scanners\.md'/)
  })

  it('keeps native numeric validation aligned with the public contract', () => {
    const zeroChecks = nativeSource.match(
      /\(key == "buffer_size" && number == 0\)/g,
    ) ?? []
    assert.equal(zeroChecks.length, 2)
  })
})
