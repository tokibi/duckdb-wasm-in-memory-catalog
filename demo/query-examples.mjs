const examples = {
  metadata: `DESCRIBE demo.analytics.nation;`,
  tables: `SHOW TABLES;`,
  rows: `SELECT *\nFROM demo.analytics.nation\nLIMIT 10;`,
  aggregate: `SELECT\n  n_regionkey,\n  count(*) AS nations\nFROM demo.analytics.nation\nGROUP BY n_regionkey\nORDER BY n_regionkey;`,
}

const sqlEditor = document.querySelector('#sql-editor')
const queryMessage = document.querySelector('#query-message')
const queryStep = document.querySelector('[data-step="query"]')

for (const button of document.querySelectorAll('[data-query-example]')) {
  button.addEventListener('click', () => {
    const sql = examples[button.dataset.queryExample]
    if (!sql || !sqlEditor) return

    sqlEditor.value = sql
    sqlEditor.focus()

    if (queryStep && queryStep.dataset.state !== 'error') {
      queryStep.dataset.state = 'idle'
      const detail = queryStep.querySelector('[data-step-detail]')
      if (detail) detail.textContent = 'Ready'
    }

    if (queryMessage) {
      queryMessage.dataset.kind = 'idle'
      queryMessage.textContent = `${button.dataset.queryLabel || 'Query'} example loaded. Review it, then run SQL.`
    }
  })
}
