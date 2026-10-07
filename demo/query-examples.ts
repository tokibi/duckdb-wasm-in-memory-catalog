import { InMemoryCatalogController } from "../src/javascript/in-memory-catalog-controller";

const originalClose = InMemoryCatalogController.prototype.close;
InMemoryCatalogController.prototype.close = async function closeDemoCatalog() {
  try {
    await this.connection.query("USE memory");
  } catch {
    // The connection may already be closing. Preserve the controller's close behavior.
  }
  return originalClose.call(this);
};

const sqlEditor = document.querySelector<HTMLTextAreaElement>("#sql-editor");
const catalogNameInput = document.querySelector<HTMLInputElement>("#catalog-name");
const catalogEditor = document.querySelector<HTMLTextAreaElement>("#catalog-editor");
const queryMessage = document.querySelector<HTMLElement>("#query-message");
const queryStep = document.querySelector<HTMLElement>('[data-step="query"]');
const exampleButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-query-example]")];

let activeExample = null;
let activeExampleSql = null;
let bootstrapped = false;

function quoteIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}

function currentTarget() {
  const catalogName = catalogNameInput?.value.trim();
  if (!catalogName) return null;

  let snapshot;
  try {
    snapshot = JSON.parse(catalogEditor?.value || "");
  } catch {
    return null;
  }

  const schemaName = snapshot?.schemas?.[0]?.name;
  const tableName = snapshot?.schemas?.[0]?.tables?.[0]?.name;
  const csvTableName = snapshot?.schemas?.[0]?.tables?.find(
    (table) => table?.scanner?.type === "csv",
  )?.name;
  const jsonTableName = snapshot?.schemas?.[0]?.tables?.find(
    (table) => table?.scanner?.type === "json",
  )?.name;
  const xlsxTableName = snapshot?.schemas?.[0]?.tables?.find(
    (table) => table?.scanner?.type === "xlsx",
  )?.name;
  const viewName = snapshot?.schemas?.[0]?.views?.[0]?.name;
  if (typeof schemaName !== "string" || !schemaName) return null;
  if (typeof tableName !== "string" || !tableName) return null;

  return {
    catalogName,
    schemaName,
    tableName,
    csvTableName: typeof csvTableName === "string" && csvTableName ? csvTableName : null,
    jsonTableName: typeof jsonTableName === "string" && jsonTableName ? jsonTableName : null,
    xlsxTableName: typeof xlsxTableName === "string" && xlsxTableName ? xlsxTableName : null,
    viewName: typeof viewName === "string" && viewName ? viewName : null,
  };
}

function qualifiedTable(target) {
  return [target.catalogName, target.schemaName, target.tableName].map(quoteIdentifier).join(".");
}

function qualifiedView(target) {
  return [target.catalogName, target.schemaName, target.viewName].map(quoteIdentifier).join(".");
}

function quoteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function examplesFor(target) {
  if (!target) return null;
  const table = qualifiedTable(target);
  const examples: Record<string, string> = {
    metadata: `DESCRIBE ${table};`,
    tables: `SHOW ALL TABLES;`,
    rows: `SELECT *\nFROM ${table}\nLIMIT 10;`,
    aggregate: `SELECT\n  n_regionkey,\n  count(*) AS nations\nFROM ${table}\nGROUP BY n_regionkey\nORDER BY n_regionkey;`,
  };

  if (target.csvTableName) {
    const csvTable = [target.catalogName, target.schemaName, target.csvTableName]
      .map(quoteIdentifier)
      .join(".");
    examples.csvRows = `SELECT *
FROM ${csvTable}
ORDER BY event_id;`;
  }

  if (target.jsonTableName) {
    const jsonTable = [target.catalogName, target.schemaName, target.jsonTableName]
      .map(quoteIdentifier)
      .join(".");
    examples.jsonRows = `SELECT
  event_id,
  context.browser AS browser,
  context.tags AS tags,
  payload->>'$.action' AS action
FROM ${jsonTable}
ORDER BY event_id;`;
  }

  if (target.xlsxTableName) {
    const xlsxTable = [target.catalogName, target.schemaName, target.xlsxTableName]
      .map(quoteIdentifier)
      .join(".");
    examples.xlsxRows = `SELECT *
FROM ${xlsxTable}
ORDER BY ABC;`;
  }

  if (target.viewName) {
    const view = qualifiedView(target);
    examples.viewMetadata = `SELECT
  database_name,
  schema_name,
  view_name,
  sql
FROM duckdb_views()
WHERE database_name = ${quoteString(target.catalogName)}
  AND schema_name = ${quoteString(target.schemaName)};`;
    examples.viewRows = `SELECT *
FROM ${view};`;
  }

  return examples;
}

function compactSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function refreshExampleCards(target = currentTarget()) {
  const examples = examplesFor(target);
  for (const button of exampleButtons) {
    const key = button.dataset.queryExample;
    const sql = examples?.[key];
    button.disabled = !sql;
    const preview = button.querySelector("code");
    if (preview)
      preview.textContent = sql ? compactSql(sql) : "Fix Catalog JSON to load this example.";
  }
}

function loadExample(key, { announce = true, focus = true } = {}) {
  const examples = examplesFor(currentTarget());
  const sql = examples?.[key];
  if (!sql || !sqlEditor) return false;

  activeExample = key;
  activeExampleSql = sql;
  sqlEditor.value = sql;
  if (focus) sqlEditor.focus();

  if (queryStep?.dataset.state !== "error") {
    queryStep.dataset.state = "idle";
    const detail = queryStep.querySelector("[data-step-detail]");
    if (detail) detail.textContent = "Ready";

    if (announce && queryMessage) {
      const button = exampleButtons.find((candidate) => candidate.dataset.queryExample === key);
      queryMessage.dataset.kind = "idle";
      queryMessage.textContent = `${button?.dataset.queryLabel || "Query"} example loaded. Review it, then run SQL.`;
    }
  }

  return true;
}

function detectActiveExample() {
  const examples = examplesFor(currentTarget());
  const currentSql = sqlEditor?.value;
  if (!examples || !currentSql) return false;

  for (const [key, sql] of Object.entries(examples)) {
    if (currentSql === sql) {
      activeExample = key;
      activeExampleSql = sql;
      return true;
    }
  }
  return false;
}

function handleCatalogEdit() {
  const shouldFollowCatalog =
    activeExample !== null && activeExampleSql !== null && sqlEditor?.value === activeExampleSql;

  refreshExampleCards();

  if (shouldFollowCatalog) {
    loadExample(activeExample, { announce: false, focus: false });
  }
}

for (const button of exampleButtons) {
  button.addEventListener("click", () => {
    loadExample(button.dataset.queryExample);
  });
}

catalogNameInput?.addEventListener("input", handleCatalogEdit);
catalogEditor?.addEventListener("input", handleCatalogEdit);
sqlEditor?.addEventListener("input", () => {
  if (activeExampleSql !== null && sqlEditor.value !== activeExampleSql) {
    activeExample = null;
    activeExampleSql = null;
  }
});

function bootstrap() {
  refreshExampleCards();
  if (!bootstrapped && currentTarget() && sqlEditor?.value) {
    detectActiveExample();
    bootstrapped = true;
    return;
  }
  if (!bootstrapped) requestAnimationFrame(bootstrap);
}

bootstrap();
