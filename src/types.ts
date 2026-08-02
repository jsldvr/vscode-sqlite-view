export type Primitive = string | number | bigint | null | Uint8Array;

export interface SerializedBlob {
  type: 'blob';
  base64: string;
  length: number;
}

export type SerializedValue = string | number | null | SerializedBlob;

export interface DatabaseReference {
  id: string;
  name: string;
  path: string;
  encrypted?: boolean;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyOrder: number;
  hidden: number;
}

export interface SchemaObject {
  type: 'table' | 'view' | 'index' | 'trigger';
  name: string;
  tableName: string;
  sql: string | null;
  columns?: ColumnInfo[];
  withoutRowid?: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, SerializedValue>[];
  changes: number;
  lastInsertRowid?: number;
  truncated: boolean;
  elapsedMs: number;
  statement: string;
}

export interface PageResult {
  columns: ColumnInfo[];
  rows: Record<string, SerializedValue>[];
  page: number;
  pageSize: number;
  totalRows: number;
  editable: boolean;
  locatorColumns: string[];
}

export interface QueryLogEntry {
  id: number;
  timestamp: string;
  sql: string;
  params: unknown[];
  elapsedMs: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface BrowseOptions {
  page: number;
  pageSize: number;
  sort?: { column: string; direction: 'ASC' | 'DESC' };
  search?: string;
}

export interface ColumnDefinition {
  name: string;
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  defaultExpression?: string;
}
