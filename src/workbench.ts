import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { errorMessage } from './connectionTree';
import { ColumnDefinition, DatabaseReference } from './types';

class DatabaseDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri, public readonly reference: DatabaseReference) {}
  public dispose(): void {}
}

type Message = { type: string; requestId?: number; [key: string]: unknown };

export class WorkbenchProvider implements vscode.CustomReadonlyEditorProvider<DatabaseDocument> {
  public static readonly viewType = 'sqliteView.databaseEditor';

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly onSchemaChanged: () => void,
  ) {}

  public async openCustomDocument(uri: vscode.Uri): Promise<DatabaseDocument> {
    const reference = await this.connections.add(uri.fsPath);
    return new DatabaseDocument(uri, reference);
  }

  public async resolveCustomEditor(document: DatabaseDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = this.html(panel.webview, document.reference);
    panel.webview.onDidReceiveMessage(message => this.receive(document.reference, panel.webview, message), undefined, this.context.subscriptions);
  }

  private async receive(reference: DatabaseReference, webview: vscode.Webview, raw: unknown): Promise<void> {
    if (!isMessage(raw)) return;
    const message = raw;
    try {
      const session = await this.connections.session(reference);
      let payload: unknown;
      switch (message.type) {
        case 'ready':
        case 'schema':
          payload = { schema: await session.schema(), reference };
          break;
        case 'browse':
          payload = await session.browse(requiredString(message.table), {
            page: numberValue(message.page, 0),
            pageSize: numberValue(message.pageSize, this.pageSize()),
            search: optionalString(message.search),
            sort: parseSort(message.sort),
          });
          break;
        case 'execute':
          payload = await session.execute(requiredString(message.sql), this.queryLimit());
          break;
        case 'insert':
          await session.insert(requiredString(message.table), recordValue(message.values));
          payload = { ok: true };
          break;
        case 'update':
          await session.update(requiredString(message.table), recordValue(message.values), recordValue(message.locator));
          payload = { ok: true };
          break;
        case 'delete':
          await session.delete(requiredString(message.table), recordValue(message.locator));
          payload = { ok: true };
          break;
        case 'createTable':
          await session.createTable(requiredString(message.name), columnDefinitions(message.columns));
          this.onSchemaChanged();
          payload = { schema: await session.schema() };
          break;
        case 'createIndex':
          await session.createIndex(requiredString(message.table), requiredString(message.name), stringArray(message.columns), Boolean(message.unique));
          this.onSchemaChanged();
          payload = { schema: await session.schema() };
          break;
        case 'alterTable': {
          const table = requiredString(message.table);
          const action = requiredString(message.action);
          if (action === 'renameTable') await session.renameTable(table, requiredString(message.newName));
          else if (action === 'addColumn') await session.addColumn(table, columnDefinitions([message.column])[0]);
          else if (action === 'renameColumn') await session.renameColumn(table, requiredString(message.column), requiredString(message.newName));
          else if (action === 'dropColumn') {
            const column = requiredString(message.column);
            const confirmed = await vscode.window.showWarningMessage(`Drop column ${column} from ${table}? SQLite may reject this when schema objects depend on the column.`, { modal: true }, 'Drop Column');
            if (confirmed !== 'Drop Column') throw new Error('Column drop cancelled.');
            await session.dropColumn(table, column);
          } else throw new Error('Unsupported table alteration.');
          this.onSchemaChanged();
          payload = { schema: await session.schema() };
          break;
        }
        case 'dropObject': {
          const type = requiredString(message.objectType);
          if (!['table', 'view', 'index', 'trigger'].includes(type)) throw new Error('Invalid schema object type.');
          const name = requiredString(message.name);
          const confirmed = await vscode.window.showWarningMessage(`Drop ${type} ${name}? This cannot be undone.`, { modal: true }, 'Drop');
          if (confirmed !== 'Drop') throw new Error('Drop cancelled.');
          await session.dropObject(type as 'table' | 'view' | 'index' | 'trigger', name);
          this.onSchemaChanged();
          payload = { schema: await session.schema() };
          break;
        }
        case 'compact':
          await session.compact();
          payload = { ok: true };
          break;
        case 'logs':
          payload = session.getLogs();
          break;
        case 'clearLogs':
          session.clearLogs();
          payload = [];
          break;
        case 'exportCsv':
          payload = await this.exportCsv(reference, requiredString(message.table));
          break;
        case 'importCsv':
          payload = await this.importCsv(reference, requiredString(message.table));
          break;
        case 'exportSql':
          payload = await this.exportSql(reference);
          break;
        case 'importSql':
          payload = await this.importSql(reference);
          this.onSchemaChanged();
          break;
        default:
          throw new Error(`Unknown workbench message: ${message.type}`);
      }
      await webview.postMessage({ type: 'response', requestId: message.requestId, requestType: message.type, payload });
    } catch (error) {
      await webview.postMessage({ type: 'response', requestId: message.requestId, requestType: message.type, error: errorMessage(error) });
    }
  }

  private async exportCsv(reference: DatabaseReference, table: string): Promise<{ saved: boolean }> {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(reference.path), `${table}.csv`)), filters: { CSV: ['csv'], Text: ['txt'] } });
    if (!target) return { saved: false };
    await fs.writeFile(target.fsPath, await (await this.connections.session(reference)).exportCsv(table), 'utf8');
    return { saved: true };
  }

  private async importCsv(reference: DatabaseReference, table: string): Promise<{ imported: number } | { imported: 0; cancelled: true }> {
    const source = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'], Text: ['txt'] } });
    if (!source?.[0]) return { imported: 0, cancelled: true };
    const count = await (await this.connections.session(reference)).importCsv(table, await fs.readFile(source[0].fsPath, 'utf8'));
    return { imported: count };
  }

  private async exportSql(reference: DatabaseReference): Promise<{ saved: boolean }> {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${reference.path}.sql`), filters: { SQL: ['sql'] } });
    if (!target) return { saved: false };
    await fs.writeFile(target.fsPath, await (await this.connections.session(reference)).dumpSql(), 'utf8');
    return { saved: true };
  }

  private async importSql(reference: DatabaseReference): Promise<{ imported: boolean }> {
    const source = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQL: ['sql'] } });
    if (!source?.[0]) return { imported: false };
    const answer = await vscode.window.showWarningMessage(`Execute every statement in ${path.basename(source[0].fsPath)} against ${reference.name}?`, { modal: true }, 'Import');
    if (answer !== 'Import') return { imported: false };
    await (await this.connections.session(reference)).importSql(await fs.readFile(source[0].fsPath, 'utf8'));
    return { imported: true };
  }

  private pageSize(): number {
    return vscode.workspace.getConfiguration('sqliteView').get<number>('pageSize', 100);
  }

  private queryLimit(): number {
    return vscode.workspace.getConfiguration('sqliteView').get<number>('queryRowLimit', 5000);
  }

  private html(webview: vscode.Webview, reference: DatabaseReference): string {
    const nonce = randomNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'workbench.css'));
    const queryBuilderJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'queryBuilder.js'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'workbench.js'));
    const title = escapeHtml(reference.name);
    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>${title}</title></head>
<body>
  <header><div><h1>${title}</h1><span id="database-path">${escapeHtml(reference.path)}</span></div><span id="status">Opening...</span></header>
  <nav id="tabs" aria-label="Database tools">
    <button data-tab="browse" class="active">Browse</button><button data-tab="sql">SQL</button><button data-tab="schema">Schema</button><button data-tab="transfer">Import / Export</button><button data-tab="chart">Chart</button><button data-tab="log">Log</button>
  </nav>
  <main>
    <section id="browse" class="tab active">
      <div class="toolbar"><label>Table <select id="table-select"></select></label><input id="search" type="search" placeholder="Search all columns"><button id="refresh">Refresh</button><button id="add-row">Add row</button><button id="delete-row" class="danger" disabled>Delete selected</button></div>
      <div id="grid-wrap"><table id="grid"><thead></thead><tbody></tbody></table></div>
      <footer><button id="previous">Previous</button><span id="page-info">No rows</span><button id="next">Next</button></footer>
    </section>
    <section id="sql" class="tab">
      <div class="sql-layout">
        <section class="query-builder"><h2>Query builder</h2><div class="query-builder-fields">
          <label class="builder-field">Table<select id="builder-table"></select></label>
          <div class="builder-field builder-columns-field"><span id="builder-columns-label">Columns</span><div id="builder-columns" class="projection-picker"><div id="projection-tags" class="projection-tags"></div><input id="projection-input" type="text" role="combobox" aria-labelledby="builder-columns-label" aria-controls="projection-suggestions" aria-expanded="false" aria-autocomplete="list" autocomplete="off" placeholder="Add column or count..."><div id="projection-suggestions" class="projection-suggestions" role="listbox" hidden></div></div></div>
          <label class="builder-field builder-field-wide">Where<input id="builder-where" placeholder="status = 'active'"></label><label class="builder-field builder-field-wide">Order by<input id="builder-order"></label><label class="builder-field builder-limit-field">Limit<input id="builder-limit" type="number" value="100"></label><button id="build-query">Build SQL</button>
        </div></section>
        <div class="query-area"><textarea id="sql-editor" spellcheck="false">SELECT name, type FROM sqlite_schema ORDER BY type, name;</textarea><div class="toolbar"><button id="run-sql" class="primary">Run SQL</button><button id="clear-sql">Clear</button><span>Ctrl+Enter to run</span></div><div id="query-results"></div></div>
      </div>
    </section>
    <section id="schema" class="tab"><div class="toolbar"><button id="create-table">Create table</button><button id="create-index">Create index</button></div><div id="schema-list"></div></section>
    <section id="transfer" class="tab"><div class="cards"><article><h2>CSV</h2><p>Import or export the selected table using a header row.</p><button id="import-csv">Import CSV</button><button id="export-csv">Export CSV</button></article><article><h2>SQL dump</h2><p>Import or export the complete database schema and records.</p><button id="import-sql">Import SQL</button><button id="export-sql">Export SQL</button></article><article><h2>Maintenance</h2><p>Rebuild the database file and reclaim unused pages.</p><button id="compact">Compact database</button></article></div></section>
    <section id="chart" class="tab"><div class="toolbar"><label>Label<select id="chart-label"></select></label><label>Value<select id="chart-value"></select></label><button id="draw-chart">Plot current result</button></div><canvas id="chart-canvas" width="900" height="420"></canvas><p id="chart-empty">Run a query, then choose label and numeric value columns.</p></section>
    <section id="log" class="tab"><div class="toolbar"><button id="refresh-log">Refresh</button><button id="clear-log">Clear</button></div><div id="log-list"></div></section>
  </main>
  <dialog id="row-dialog"><form method="dialog"><h2 id="row-dialog-title">Edit row</h2><div id="row-fields"></div><div class="dialog-actions"><button value="cancel">Cancel</button><button id="save-row" value="default" class="primary">Save</button></div></form></dialog>
  <dialog id="schema-dialog"><form method="dialog"><h2 id="schema-dialog-title"></h2><div id="schema-fields"></div><div class="dialog-actions"><button value="cancel">Cancel</button><button id="save-schema" value="default" class="primary">Create</button></div></form></dialog>
  <div id="toast" role="status"></div>
  <script nonce="${nonce}" src="${queryBuilderJs}"></script>
  <script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).type === 'string';
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A required string value is missing.');
  return value;
}
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object value.');
  return value as Record<string, unknown>;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Expected a string array.');
  return value as string[];
}
function columnDefinitions(value: unknown): ColumnDefinition[] {
  if (!Array.isArray(value)) throw new Error('Expected column definitions.');
  return value.map(item => {
    const record = recordValue(item);
    return { name: requiredString(record.name), type: requiredString(record.type), notNull: Boolean(record.notNull), primaryKey: Boolean(record.primaryKey), unique: Boolean(record.unique), defaultExpression: optionalString(record.defaultExpression) };
  });
}
function parseSort(value: unknown): { column: string; direction: 'ASC' | 'DESC' } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const sort = value as Record<string, unknown>;
  if (typeof sort.column !== 'string' || (sort.direction !== 'ASC' && sort.direction !== 'DESC')) return undefined;
  return { column: sort.column, direction: sort.direction };
}
function randomNonce(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join(''); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char); }
