import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSession } from '../src/database';

test('database session supports schema, CRUD, paging, SQL, CSV, and dumps', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-view-test-'));
  const file = path.join(directory, 'test.sqlite');
  const database = new DatabaseSession(file);
  t.after(async () => {
    await database.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await database.open(true);
  await database.createTable('people', [
    { name: 'id', type: 'INTEGER', primaryKey: true },
    { name: 'name', type: 'TEXT', notNull: true },
    { name: 'score', type: 'REAL' },
  ]);
  await database.insert('people', { name: 'Ada', score: 9.5 });
  await database.insert('people', { name: 'Grace', score: 10 });
  await database.addColumn('people', { name: 'active', type: 'INTEGER', notNull: true, defaultExpression: '1' });
  await database.renameColumn('people', 'active', 'enabled');

  const page = await database.browse('people', { page: 0, pageSize: 1, search: 'Ada' });
  assert.equal(page.totalRows, 1);
  assert.equal(page.rows[0].name, 'Ada');
  assert.deepEqual(page.locatorColumns, ['id']);

  await database.update('people', { score: 11 }, { id: page.rows[0].id });
  const results = await database.execute('SELECT name, score FROM people ORDER BY name; UPDATE people SET score = score + 1 WHERE name = \'Grace\';', 100);
  assert.equal(results[0].rows.length, 2);
  assert.equal(results[1].changes, 1);

  const csv = await database.exportCsv('people');
  assert.match(csv, /Ada/);
  await database.createTable('copy', [{ name: 'id', type: 'TEXT' }, { name: 'name', type: 'TEXT' }, { name: 'score', type: 'TEXT' }, { name: 'enabled', type: 'TEXT' }]);
  assert.equal(await database.importCsv('copy', csv), 2);

  const dump = await database.dumpSql();
  assert.match(dump, /CREATE TABLE "people"/);
  assert.match(dump, /INSERT INTO "people"/);
  assert.ok(database.getLogs().length > 0);
});

test('table wizard rejects executable SQL fragments', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-view-safe-ddl-'));
  const database = new DatabaseSession(path.join(directory, 'test.sqlite'));
  t.after(async () => { await database.close().catch(() => undefined); await fs.rm(directory, { recursive: true, force: true }); });
  await database.open(true);
  await assert.rejects(() => database.createTable('unsafe', [{ name: 'value', type: 'TEXT); DROP TABLE data; --' }]));
  await assert.rejects(() => database.createTable('unsafe', [{ name: 'value', type: 'TEXT', defaultExpression: '0); DROP TABLE data; --' }]));
});

test('rowid fallback makes ordinary tables editable without a primary key', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-view-rowid-'));
  const file = path.join(directory, 'test.sqlite');
  const database = new DatabaseSession(file);
  t.after(async () => { await database.close().catch(() => undefined); await fs.rm(directory, { recursive: true, force: true }); });
  await database.open(true);
  await database.execute('CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'hello\');', 10);
  const page = await database.browse('notes', { page: 0, pageSize: 10 });
  assert.equal(page.editable, true);
  assert.deepEqual(page.locatorColumns, ['__sqlite_view_rowid__']);
  await database.delete('notes', { __sqlite_view_rowid__: page.rows[0].__sqlite_view_rowid__ });
  assert.equal((await database.browse('notes', { page: 0, pageSize: 10 })).totalRows, 0);
});
