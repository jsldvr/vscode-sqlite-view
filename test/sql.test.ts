import assert from 'node:assert/strict';
import test from 'node:test';
import { deserializeValue, isReadStatement, quoteIdentifier, serializeValue, splitSqlStatements, sqlLiteral } from '../src/sql';

test('quoteIdentifier escapes quotes and rejects invalid names', () => {
  assert.equal(quoteIdentifier('odd"name'), '"odd""name"');
  assert.throws(() => quoteIdentifier(''));
  assert.throws(() => quoteIdentifier('bad\0name'));
});

test('splitSqlStatements ignores semicolons in strings and comments', () => {
  assert.deepEqual(splitSqlStatements("SELECT ';'; -- ;\nSELECT 2; /* ; */"), ["SELECT ';'", '-- ;\nSELECT 2', '/* ; */']);
});

test('isReadStatement handles comments and CTEs', () => {
  assert.equal(isReadStatement('-- comment\nSELECT 1'), true);
  assert.equal(isReadStatement('WITH items AS (SELECT 1) SELECT * FROM items'), true);
  assert.equal(isReadStatement('UPDATE items SET value = 1'), false);
});

test('SQLite values serialize safely for a webview', () => {
  const blob = serializeValue(Buffer.from([0, 1, 255]));
  assert.deepEqual(blob, { type: 'blob', base64: 'AAH/', length: 3 });
  assert.deepEqual(deserializeValue(blob), Buffer.from([0, 1, 255]));
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral(null), 'NULL');
});
