import sqlite3 from 'sqlite3';
import { BrowseOptions, ColumnDefinition, ColumnInfo, PageResult, Primitive, QueryLogEntry, QueryResult, SchemaObject } from './types';
import { deserializeValue, isReadStatement, quoteIdentifier, serializeValue, splitSqlStatements, sqlLiteral } from './sql';
import { parseCsv, stringifyCsv } from './csv';

type SqliteModule = typeof sqlite3;
type Row = Record<string, unknown>;

export class DatabaseSession {
  private db?: sqlite3.Database;
  private logSequence = 0;
  private readonly logs: QueryLogEntry[] = [];

  public constructor(
    public readonly filePath: string,
    private readonly busyTimeout = 5000,
    private readonly driver: SqliteModule = sqlite3,
    private readonly key?: string,
  ) {}

  public async open(create = false): Promise<void> {
    if (this.db) return;
    const flags = create
      ? this.driver.OPEN_READWRITE | this.driver.OPEN_CREATE
      : this.driver.OPEN_READWRITE;
    this.db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const database = new this.driver.Database(this.filePath, flags, error => error ? reject(error) : resolve(database));
    });
    try {
      if (this.key !== undefined) {
        await this.execRaw(`PRAGMA key = "x'${Buffer.from(this.key, 'utf8').toString('hex')}'"`);
      }
      await this.execRaw(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(this.busyTimeout))}`);
      await this.execRaw('PRAGMA foreign_keys = ON');
      await this.getRaw('SELECT count(*) AS count FROM sqlite_schema');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    const database = this.db;
    this.db = undefined;
    if (!database) return;
    await new Promise<void>((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
  }

  public getLogs(): QueryLogEntry[] {
    return [...this.logs].reverse();
  }

  public clearLogs(): void {
    this.logs.length = 0;
  }

  public async schema(): Promise<SchemaObject[]> {
    const objects = await this.all<Row>(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END, name`,
    );
    const result: SchemaObject[] = [];
    for (const object of objects) {
      const item: SchemaObject = {
        type: object.type as SchemaObject['type'],
        name: String(object.name),
        tableName: String(object.tableName),
        sql: object.sql === null ? null : String(object.sql),
      };
      if (item.type === 'table' || item.type === 'view') {
        item.columns = await this.columns(item.name);
        item.withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(item.sql ?? '');
      }
      result.push(item);
    }
    return result;
  }

  public async columns(table: string): Promise<ColumnInfo[]> {
    const rows = await this.all<Row>(`PRAGMA table_xinfo(${quoteIdentifier(table)})`);
    return rows.map(row => ({
      cid: Number(row.cid),
      name: String(row.name),
      type: String(row.type ?? ''),
      notNull: Boolean(row.notnull),
      defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
      primaryKeyOrder: Number(row.pk),
      hidden: Number(row.hidden ?? 0),
    }));
  }

  public async browse(table: string, options: BrowseOptions): Promise<PageResult> {
    const columns = await this.columns(table);
    if (columns.length === 0) throw new Error(`Table or view not found: ${table}`);
    const schemaRow = await this.get<Row>('SELECT type, sql FROM sqlite_schema WHERE name = ?', [table]);
    const isTable = schemaRow?.type === 'table';
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(String(schemaRow?.sql ?? ''));
    const primaryKeys = columns.filter(column => column.primaryKeyOrder > 0).sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder).map(column => column.name);
    const locatorColumns = primaryKeys.length > 0 ? primaryKeys : withoutRowid ? [] : ['__sqlite_view_rowid__'];
    const visibleColumns = columns.filter(column => column.hidden === 0);
    const params: Primitive[] = [];
    let where = '';
    if (options.search) {
      where = ` WHERE ${visibleColumns.map(column => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`).join(' OR ')}`;
      for (let index = 0; index < visibleColumns.length; index += 1) params.push(`%${options.search}%`);
    }
    let order = '';
    if (options.sort && visibleColumns.some(column => column.name === options.sort?.column)) {
      order = ` ORDER BY ${quoteIdentifier(options.sort.column)} ${options.sort.direction}`;
    }
    const pageSize = Math.max(1, Math.min(1000, Math.trunc(options.pageSize)));
    const page = Math.max(0, Math.trunc(options.page));
    const rowidSelect = locatorColumns[0] === '__sqlite_view_rowid__' ? 'rowid AS "__sqlite_view_rowid__", ' : '';
    const rows = await this.all<Row>(
      `SELECT ${rowidSelect}* FROM ${quoteIdentifier(table)}${where}${order} LIMIT ? OFFSET ?`,
      [...params, pageSize, page * pageSize],
    );
    const count = await this.get<Row>(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}${where}`, params);
    return {
      columns,
      rows: rows.map(serializeRow),
      page,
      pageSize,
      totalRows: Number(count?.count ?? 0),
      editable: isTable && locatorColumns.length > 0,
      locatorColumns,
    };
  }

  public async insert(table: string, values: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      await this.run(`INSERT INTO ${quoteIdentifier(table)} DEFAULT VALUES`);
      return;
    }
    await this.run(
      `INSERT INTO ${quoteIdentifier(table)} (${entries.map(([name]) => quoteIdentifier(name)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`,
      entries.map(([, value]) => deserializeValue(value)),
    );
  }

  public async update(table: string, values: Record<string, unknown>, locator: Record<string, unknown>): Promise<void> {
    const changes = Object.entries(values);
    if (changes.length === 0) return;
    const [where, locatorParams] = locatorClause(locator);
    const result = await this.run(
      `UPDATE ${quoteIdentifier(table)} SET ${changes.map(([name]) => `${quoteIdentifier(name)} = ?`).join(', ')} WHERE ${where}`,
      [...changes.map(([, value]) => deserializeValue(value)), ...locatorParams],
    );
    if (result.changes !== 1) throw new Error(`Expected to update one row, but SQLite updated ${result.changes}. Refresh and try again.`);
  }

  public async delete(table: string, locator: Record<string, unknown>): Promise<void> {
    const [where, params] = locatorClause(locator);
    const result = await this.run(`DELETE FROM ${quoteIdentifier(table)} WHERE ${where}`, params);
    if (result.changes !== 1) throw new Error(`Expected to delete one row, but SQLite deleted ${result.changes}. Refresh and try again.`);
  }

  public async createTable(name: string, columns: ColumnDefinition[]): Promise<void> {
    if (columns.length === 0) throw new Error('A table requires at least one column.');
    const definitions = columns.map(columnSql);
    await this.run(`CREATE TABLE ${quoteIdentifier(name)} (${definitions.join(', ')})`);
  }

  public async renameTable(table: string, newName: string): Promise<void> {
    await this.run(`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(newName)}`);
  }

  public async addColumn(table: string, column: ColumnDefinition): Promise<void> {
    if (column.primaryKey || column.unique) throw new Error('SQLite cannot add PRIMARY KEY or UNIQUE columns directly. Use the SQL editor and a table-rebuild transaction.');
    await this.run(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${columnSql(column)}`);
  }

  public async renameColumn(table: string, column: string, newName: string): Promise<void> {
    await this.run(`ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(column)} TO ${quoteIdentifier(newName)}`);
  }

  public async dropColumn(table: string, column: string): Promise<void> {
    await this.run(`ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`);
  }

  public async createIndex(table: string, name: string, columns: string[], unique: boolean): Promise<void> {
    if (columns.length === 0) throw new Error('An index requires at least one column.');
    await this.run(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')})`);
  }

  public async dropObject(type: SchemaObject['type'], name: string): Promise<void> {
    const keyword = type.toUpperCase();
    if (!['TABLE', 'VIEW', 'INDEX', 'TRIGGER'].includes(keyword)) throw new Error('Unsupported schema object type.');
    await this.run(`DROP ${keyword} ${quoteIdentifier(name)}`);
  }

  public async compact(): Promise<void> {
    await this.run('VACUUM');
  }

  public async execute(script: string, rowLimit: number): Promise<QueryResult[]> {
    const statements = splitSqlStatements(script);
    if (statements.length === 0) return [];
    const results: QueryResult[] = [];
    for (const statement of statements) {
      const start = performance.now();
      if (isReadStatement(statement)) {
        const rows = await this.allLimited<Row>(statement, [], rowLimit + 1);
        const truncated = rows.length > rowLimit;
        const kept = rows.slice(0, rowLimit);
        results.push({
          columns: kept.length > 0 ? Object.keys(kept[0]) : [],
          rows: kept.map(serializeRow),
          changes: 0,
          truncated,
          elapsedMs: performance.now() - start,
          statement,
        });
      } else {
        const run = await this.run(statement);
        results.push({ columns: [], rows: [], changes: run.changes, lastInsertRowid: run.lastID, truncated: false, elapsedMs: performance.now() - start, statement });
      }
    }
    return results;
  }

  public async exportCsv(table: string): Promise<string> {
    const rows = await this.all<Row>(`SELECT * FROM ${quoteIdentifier(table)}`);
    const columns = await this.columns(table);
    return stringifyCsv(columns.filter(column => column.hidden === 0).map(column => column.name), rows);
  }

  public async importCsv(table: string, csv: string): Promise<number> {
    const parsed = parseCsv(csv);
    if (parsed.length < 1) throw new Error('CSV is empty.');
    const [headers, ...rows] = parsed;
    if (headers.length === 0 || new Set(headers).size !== headers.length) throw new Error('CSV headers must be present and unique.');
    const available = new Set((await this.columns(table)).map(column => column.name));
    const missing = headers.filter(header => !available.has(header));
    if (missing.length > 0) throw new Error(`CSV columns not found in table: ${missing.join(', ')}`);
    await this.transaction(async () => {
      const sql = `INSERT INTO ${quoteIdentifier(table)} (${headers.map(quoteIdentifier).join(', ')}) VALUES (${headers.map(() => '?').join(', ')})`;
      for (const row of rows) {
        if (row.length !== headers.length) throw new Error('CSV row has a different field count than its header.');
        await this.run(sql, row);
      }
    });
    return rows.length;
  }

  public async dumpSql(): Promise<string> {
    const objects = await this.all<Row>(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END`,
    );
    const lines = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
    for (const object of objects.filter(item => item.type === 'table')) {
      lines.push(`${object.sql};`);
      const table = String(object.name);
      const rows = await this.all<Row>(`SELECT * FROM ${quoteIdentifier(table)}`);
      for (const row of rows) {
        const entries = Object.entries(row);
        lines.push(`INSERT INTO ${quoteIdentifier(table)} (${entries.map(([name]) => quoteIdentifier(name)).join(', ')}) VALUES (${entries.map(([, value]) => sqlLiteral(value)).join(', ')});`);
      }
    }
    for (const object of objects.filter(item => item.type !== 'table')) lines.push(`${object.sql};`);
    lines.push('COMMIT;', 'PRAGMA foreign_keys=ON;');
    return lines.join('\n');
  }

  public async importSql(script: string): Promise<void> {
    await this.exec(script);
  }

  public async transaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.run('BEGIN IMMEDIATE');
    try {
      const result = await operation();
      await this.run('COMMIT');
      return result;
    } catch (error) {
      try { await this.run('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  public async exec(sql: string): Promise<void> {
    const started = performance.now();
    try {
      await this.execRaw(sql);
      this.addLog(sql, [], started, 'ok');
    } catch (error) {
      this.addLog(sql, [], started, 'error', error);
      throw error;
    }
  }

  public async run(sql: string, params: Primitive[] = []): Promise<{ changes: number; lastID: number }> {
    const started = performance.now();
    try {
      const result = await this.runRaw(sql, params);
      this.addLog(sql, params, started, 'ok');
      return result;
    } catch (error) {
      this.addLog(sql, params, started, 'error', error);
      throw error;
    }
  }

  public async get<T extends Row>(sql: string, params: Primitive[] = []): Promise<T | undefined> {
    const started = performance.now();
    try {
      const result = await this.getRaw<T>(sql, params);
      this.addLog(sql, params, started, 'ok');
      return result;
    } catch (error) {
      this.addLog(sql, params, started, 'error', error);
      throw error;
    }
  }

  public async all<T extends Row>(sql: string, params: Primitive[] = []): Promise<T[]> {
    const started = performance.now();
    try {
      const result = await this.allRaw<T>(sql, params);
      this.addLog(sql, params, started, 'ok');
      return result;
    } catch (error) {
      this.addLog(sql, params, started, 'error', error);
      throw error;
    }
  }

  private database(): sqlite3.Database {
    if (!this.db) throw new Error('Database is not open.');
    return this.db;
  }

  private execRaw(sql: string): Promise<void> {
    return new Promise((resolve, reject) => this.database().exec(sql, error => error ? reject(error) : resolve()));
  }

  private runRaw(sql: string, params: Primitive[]): Promise<{ changes: number; lastID: number }> {
    return new Promise((resolve, reject) => {
      this.database().run(sql, params, function (error) {
        if (error) reject(error);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  private getRaw<T extends Row>(sql: string, params: Primitive[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => this.database().get(sql, params, (error, row) => error ? reject(error) : resolve(row as T | undefined)));
  }

  private allRaw<T extends Row>(sql: string, params: Primitive[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => this.database().all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[])));
  }

  private allLimited<T extends Row>(sql: string, params: Primitive[], limit: number): Promise<T[]> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const rows: T[] = [];
      this.database().each(sql, params, (error, row) => {
        if (error) return;
        if (rows.length < limit) rows.push(row as T);
      }, error => {
        if (error) {
          this.addLog(sql, params, started, 'error', error);
          reject(error);
        } else {
          this.addLog(sql, params, started, 'ok');
          resolve(rows);
        }
      });
    });
  }

  private addLog(sql: string, params: unknown[], started: number, status: 'ok' | 'error', error?: unknown): void {
    this.logs.push({
      id: ++this.logSequence,
      timestamp: new Date().toISOString(),
      sql: redactSql(sql),
      params: params.map(value => Buffer.isBuffer(value) ? `[BLOB ${value.length} bytes]` : value),
      elapsedMs: performance.now() - started,
      status,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
    });
    if (this.logs.length > 1000) this.logs.shift();
  }
}

function redactSql(sql: string): string {
  return sql
    .replace(/(PRAGMA\s+key\s*=\s*)(?:"x'[0-9a-f]*'"|'(?:''|[^'])*'|"(?:""|[^"])*")/gi, '$1[REDACTED]')
    .replace(/(\bKEY\s+)(?:"x'[0-9a-f]*'"|'(?:''|[^'])*'|"(?:""|[^"])*")/gi, '$1[REDACTED]');
}

function serializeRow(row: Row): Record<string, ReturnType<typeof serializeValue>> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeValue(value)]));
}

function locatorClause(locator: Record<string, unknown>): [string, Primitive[]] {
  const entries = Object.entries(locator);
  if (entries.length === 0) throw new Error('A row locator is required.');
  return [
    entries.map(([name], index) => deserializeValue(entries[index][1]) === null ? `${quoteIdentifier(name === '__sqlite_view_rowid__' ? 'rowid' : name)} IS NULL` : `${quoteIdentifier(name === '__sqlite_view_rowid__' ? 'rowid' : name)} = ?`).join(' AND '),
    entries.filter(([, value]) => deserializeValue(value) !== null).map(([, value]) => deserializeValue(value)),
  ];
}

function columnSql(column: ColumnDefinition): string {
  const type = column.type.trim() || 'TEXT';
  if (!/^[A-Za-z][A-Za-z0-9_ ]*(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?$/.test(type)) {
    throw new Error('The column type contains unsupported SQL. Use the SQL editor for custom declarations.');
  }
  const parts = [quoteIdentifier(column.name), type];
  if (column.primaryKey) parts.push('PRIMARY KEY');
  if (column.notNull) parts.push('NOT NULL');
  if (column.unique) parts.push('UNIQUE');
  if (column.defaultExpression?.trim()) {
    const expression = column.defaultExpression.trim();
    if (!/^(?:NULL|[-+]?\d+(?:\.\d+)?|CURRENT_(?:TIME|DATE|TIMESTAMP)|'(?:''|[^'])*')$/i.test(expression)) {
      throw new Error('The default must be NULL, a number, CURRENT_TIME/DATE/TIMESTAMP, or a quoted string. Use the SQL editor for other expressions.');
    }
    parts.push(`DEFAULT ${expression}`);
  }
  return parts.join(' ');
}
