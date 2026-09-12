import { defineConfig } from 'vite'
import { defaultTheme, defineTheme, oxContent } from '@ox-content/vite-plugin'

const base = '/duckdb-wasm-in-memory-catalog/docs/'
const demoUrl = 'https://tokibi.github.io/duckdb-wasm-in-memory-catalog/'

export default defineConfig({
  base,
  plugins: [
    oxContent({
      srcDir: 'content',
      outDir: '../build/pages/docs',
      base,
      docs: false,
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
            { text: { en: 'Guide', ja: 'ガイド' }, link: '/getting-started/' },
            { text: { en: 'Live demo', ja: 'ライブデモ' }, link: demoUrl },
            { text: 'GitHub', link: 'https://github.com/tokibi/duckdb-wasm-in-memory-catalog' },
          ],
          sidebar: [
            {
              text: 'Documentation',
              items: [
                { text: 'Overview', link: '/index.md' },
                { text: 'Getting started', link: '/getting-started.md' },
                { text: 'Guides', link: '/guides.md' },
                { text: 'Concepts', link: '/concepts.md' },
                { text: 'Reference', link: '/reference.md' },
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
