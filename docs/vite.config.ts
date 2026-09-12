import { defineConfig } from 'vite'
import { defaultTheme, defineTheme, oxContent } from '@ox-content/vite-plugin'

const repositoryBase = '/duckdb-wasm-in-memory-catalog/'
const docsBase = `${repositoryBase}docs/`

export default defineConfig({
  base: docsBase,
  plugins: [
    oxContent({
      srcDir: 'content',
      outDir: '../build/pages/docs',
      base: docsBase,
      i18n: {
        enabled: true,
        defaultLocale: 'en',
        locales: [
          { code: 'en', name: 'English' },
          { code: 'ja', name: '日本語' },
        ],
        hideDefaultLocale: true,
        check: false,
      },
      ssg: {
        siteName: 'DuckDB-Wasm In-Memory Catalog',
        siteUrl: 'https://tokibi.github.io',
        pagination: true,
        breadcrumbs: true,
        localeSwitcher: true,
        notFound: true,
        theme: defineTheme({
          extends: defaultTheme,
          nav: [
            { text: { en: 'Guide', ja: 'ガイド' }, link: `${docsBase}getting-started/` },
            { text: { en: 'Live demo', ja: 'ライブデモ' }, link: repositoryBase },
            { text: 'GitHub', link: 'https://github.com/tokibi/duckdb-wasm-in-memory-catalog' },
          ],
          sidebar: [
            {
              text: 'Getting started',
              items: [
                { text: 'Overview', link: '/index.md' },
                { text: 'Setup', link: '/getting-started/setup.md' },
                { text: 'Your first catalog', link: '/getting-started/first-catalog.md' },
              ],
            },
            {
              text: 'Guides',
              items: [
                { text: 'Publishing catalogs', link: '/guides/publishing-catalogs.md' },
                { text: 'Updating catalogs', link: '/guides/updating-catalogs.md' },
                { text: 'Querying', link: '/guides/querying.md' },
              ],
            },
            {
              text: 'Concepts',
              items: [
                { text: 'Catalog model', link: '/concepts/catalog-model.md' },
                { text: 'Snapshots and revisions', link: '/concepts/snapshots-and-revisions.md' },
                { text: 'Scanners and files', link: '/concepts/scanners-and-files.md' },
                { text: 'Runtime model', link: '/concepts/runtime-model.md' },
              ],
            },
            {
              text: 'Reference',
              items: [
                { text: 'Snapshot format', link: '/reference/snapshot-format.md' },
                { text: 'JavaScript API', link: '/reference/javascript-api.md' },
                { text: 'Errors', link: '/reference/errors.md' },
                { text: 'Limitations', link: '/reference/limitations.md' },
              ],
            },
          ],
        }),
      },
      highlight: true,
      mermaid: true,
    }),
  ],
})
