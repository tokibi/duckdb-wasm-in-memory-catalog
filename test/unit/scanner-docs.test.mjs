import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const [metadataSource, english, japanese, viteConfig] = await Promise.all([
  readFile(new URL('../../src/javascript/in-memory-catalog-metadata-store.js', import.meta.url), 'utf8'),
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
  'all_varchar',
  'normalize_names',
  'dateformat',
  'timestampformat',
  'compression',
  'ignore_errors',
  'null_padding',
]

describe('Scanner documentation', () => {
  it('documents every CSV option accepted by the metadata store in both locales', () => {
    for (const option of csvOptions) {
      assert.match(metadataSource, new RegExp(`\\b${option}:`))
      const optionRow = new RegExp('\\| `' + option + '` \\|')
      assert.match(english, optionRow)
      assert.match(japanese, optionRow)
    }
  })

  it('exposes the dedicated scanner page in the documentation navigation', () => {
    assert.match(english, /type: 'parquet'/)
    assert.match(english, /type: 'csv'/)
    assert.match(japanese, /type: 'parquet'/)
    assert.match(japanese, /type: 'csv'/)
    assert.match(viteConfig, /link: '\/scanners\.md'/)
  })
})
