import { Primitive, SerializedValue } from './types';

export function quoteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes('\0')) {
    throw new Error('Invalid empty or null-containing identifier.');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function serializeValue(value: unknown): SerializedValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return { type: 'blob', base64: buffer.toString('base64'), length: buffer.length };
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

export function deserializeValue(value: unknown): Primitive {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (isSerializedBlob(value)) {
    return Buffer.from(value.base64, 'base64');
  }
  throw new Error('Unsupported SQLite value.');
}

function isSerializedBlob(value: unknown): value is { type: 'blob'; base64: string } {
  return typeof value === 'object' && value !== null &&
    (value as Record<string, unknown>).type === 'blob' &&
    typeof (value as Record<string, unknown>).base64 === 'string';
}

export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | ']' | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    const next = script[index + 1];

    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && char === '-' && next === '-') {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (!quote && (char === "'" || char === '"' || char === '`' || char === ']')) {
      quote = char as "'" | '"' | '`' | ']';
      current += char;
      continue;
    }
    if (quote) {
      current += char;
      const closing = quote === ']' ? ']' : quote;
      if (char === closing) {
        if (next === closing && quote !== '`') {
          current += next;
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function isReadStatement(sql: string): boolean {
  const normalized = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').toUpperCase();
  return /^(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/.test(normalized);
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
