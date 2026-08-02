import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv, stringifyCsv } from '../src/csv';

test('CSV round trip preserves commas, quotes, and newlines', () => {
  const csv = stringifyCsv(['name', 'notes'], [{ name: 'Ada, A.', notes: 'one\n"two"' }, { name: 'Null', notes: null }]);
  assert.deepEqual(parseCsv(csv), [['name', 'notes'], ['Ada, A.', 'one\n"two"'], ['Null', '']]);
});

test('CSV parser rejects unterminated quoted fields', () => {
  assert.throws(() => parseCsv('name\n"broken'));
});
