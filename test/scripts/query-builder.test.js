"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const builder = require("../../media/queryBuilder");

test("quotes SQLite identifiers", () => {
  assert.equal(builder.quoteIdentifier('order'), '"order"');
  assert.equal(builder.quoteIdentifier('odd"name'), '"odd""name"');
  assert.equal(builder.serializeProjections([{ kind: 'column', column: 'odd"name' }]), '"odd""name"');
});

test("validates selectable tables and views", () => {
  const schema = [
    { type: 'table', name: 'entries' },
    { type: 'view', name: 'active_entries' },
    { type: 'index', name: 'entries_title' },
  ];
  assert.equal(builder.isSelectableRelation(schema, 'entries'), true);
  assert.equal(builder.isSelectableRelation(schema, 'active_entries'), true);
  assert.equal(builder.isSelectableRelation(schema, ''), false);
  assert.equal(builder.isSelectableRelation(schema, 'entries_title'), false);
  assert.equal(builder.isSelectableRelation(schema, 'missing'), false);
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

test("prevents duplicate expressions", () => {
  const existing = [{ kind: 'column', column: 'title' }];
  assert.deepEqual(builder.addProjection(existing, { kind: 'column', column: 'title' }), existing);
});

test("serializes row and column counts", () => {
  assert.equal(
    builder.serializeProjections([
      { kind: 'countAll' },
      { kind: 'countColumn', column: 'title' },
    ]),
    'COUNT(*), COUNT("title")',
  );
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
