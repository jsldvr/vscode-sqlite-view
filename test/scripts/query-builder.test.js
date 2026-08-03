"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const builder = require("../../media/queryBuilder");

test("quotes SQLite identifiers and aliases", () => {
  assert.equal(builder.quoteIdentifier('order'), '"order"');
  assert.equal(builder.quoteIdentifier('odd"name'), '"odd""name"');
  assert.equal(
    builder.serializeProjections([{ kind: 'column', column: 'odd"name', alias: 'friendly name' }]),
    '"odd""name" AS "friendly name"',
  );
});

test("selecting an explicit projection replaces star", () => {
  assert.deepEqual(
    builder.addProjection([{ kind: 'star' }], { kind: 'column', column: 'title' }),
    [{ kind: 'column', column: 'title' }],
  );
  assert.deepEqual(
    builder.addProjection([{ kind: 'column', column: 'title' }], { kind: 'star' }),
    [{ kind: 'star' }],
  );
});

test("prevents duplicate expressions regardless of alias", () => {
  const existing = [{ kind: 'column', column: 'title', alias: 'heading' }];
  assert.deepEqual(builder.addProjection(existing, { kind: 'column', column: 'title' }), existing);
});

test("serializes row and column counts", () => {
  assert.equal(
    builder.serializeProjections([
      { kind: 'countAll', alias: 'total' },
      { kind: 'countColumn', column: 'title', alias: 'titled' },
    ]),
    'COUNT(*) AS "total", COUNT("title") AS "titled"',
  );
});

test("adds, changes, and removes aliases", () => {
  const selected = [{ kind: 'column', column: 'title' }];
  assert.equal(builder.projectionLabel(builder.setAlias(selected, 'column:title', 'heading')[0]), 'title AS heading');
  assert.deepEqual(builder.setAlias([{ ...selected[0], alias: 'heading' }], 'column:title', ''), selected);
});

test("removal and schema reconciliation fall back to star", () => {
  assert.deepEqual(builder.removeProjection([{ kind: 'column', column: 'title' }], 'column:title'), [{ kind: 'star' }]);
  assert.deepEqual(builder.reconcileProjections([{ kind: 'column', column: 'removed' }], ['id']), [{ kind: 'star' }]);
});

test("suggestions expose columns and count helpers", () => {
  assert.deepEqual(
    builder.projectionSuggestions(['id']).map(item => item.label),
    ['*', 'COUNT(*)', 'id', 'COUNT(id)'],
  );
});
