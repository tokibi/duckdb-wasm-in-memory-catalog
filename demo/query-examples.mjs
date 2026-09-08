const examples = {
  metadata: `DESCRIBE demo.analytics.nation;`,
  tables: `SHOW TABLES;`,
  rows: `SELECT *\nFROM demo.analytics.nation\nLIMIT 10;`,
  aggregate: `SELECT\n  n_regionkey,\n  count(*) AS nations\nFROM demo.analytics.nation\nGROUP BY n_regionkey\nORDER BY n_regionkey;`,
}

export function installQueryExamples({ sqlEditor, onLoad }) {
  for (const button of document.querySelectorAll('[data-query-example]')) {
    button.addEventListener('click', () => {
      const key = button.dataset.queryExample
      const sql = examples[key]
      if (!sql) return
      sqlEditor.value = sql
      sqlEditor.focus()
      onLoad?.(button.dataset.queryLabel || key)
    })
  }
}
