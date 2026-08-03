(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.sqliteViewQueryBuilder = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function quoteIdentifier(identifier) {
    if (typeof identifier !== 'string' || !identifier || identifier.includes('\0')) throw new Error('Invalid SQL identifier.');
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  function projectionKey(projection) {
    if (projection.kind === 'star') return 'star';
    if (projection.kind === 'countAll') return 'countAll';
    if (projection.kind === 'column') return `column:${projection.column}`;
    if (projection.kind === 'countColumn') return `countColumn:${projection.column}`;
    throw new Error('Unsupported projection kind.');
  }

  function normalizeProjection(projection) {
    const normalized = { kind: projection.kind };
    if (projection.kind === 'column' || projection.kind === 'countColumn') {
      quoteIdentifier(projection.column);
      normalized.column = projection.column;
    } else if (projection.kind !== 'star' && projection.kind !== 'countAll') {
      throw new Error('Unsupported projection kind.');
    }
    return normalized;
  }

  function addProjection(projections, projection) {
    const next = normalizeProjection(projection);
    if (next.kind === 'star') return [{ kind: 'star' }];
    const current = projections.filter(item => item.kind !== 'star').map(normalizeProjection);
    if (current.some(item => projectionKey(item) === projectionKey(next))) return current.length > 0 ? current : [{ kind: 'star' }];
    return [...current, next];
  }

  function removeProjection(projections, key) {
    const remaining = projections.filter(item => projectionKey(item) !== key).map(normalizeProjection);
    return remaining.length > 0 ? remaining : [{ kind: 'star' }];
  }

  function reconcileProjections(projections, columns) {
    const available = new Set(columns);
    const kept = [];
    for (const projection of projections) {
      const normalized = normalizeProjection(projection);
      if ((normalized.kind === 'column' || normalized.kind === 'countColumn') && !available.has(normalized.column)) continue;
      if (normalized.kind === 'star') return [{ kind: 'star' }];
      if (!kept.some(item => projectionKey(item) === projectionKey(normalized))) kept.push(normalized);
    }
    return kept.length > 0 ? kept : [{ kind: 'star' }];
  }

  function projectionExpression(projection) {
    const normalized = normalizeProjection(projection);
    let expression;
    if (normalized.kind === 'star') expression = '*';
    else if (normalized.kind === 'countAll') expression = 'COUNT(*)';
    else if (normalized.kind === 'column') expression = quoteIdentifier(normalized.column);
    else expression = `COUNT(${quoteIdentifier(normalized.column)})`;
    return expression;
  }

  function serializeProjections(projections) {
    const safe = projections.length > 0 ? projections : [{ kind: 'star' }];
    return safe.map(projectionExpression).join(', ');
  }

  function projectionLabel(projection) {
    const normalized = normalizeProjection(projection);
    let label;
    if (normalized.kind === 'star') label = '*';
    else if (normalized.kind === 'countAll') label = 'COUNT(*)';
    else if (normalized.kind === 'column') label = normalized.column;
    else label = `COUNT(${normalized.column})`;
    return label;
  }

  function projectionSuggestions(columns) {
    return [
      { kind: 'star', label: '*', detail: 'All columns' },
      { kind: 'countAll', label: 'COUNT(*)', detail: 'Count rows' },
      ...columns.flatMap(column => [
        { kind: 'column', column, label: column, detail: 'Column' },
        { kind: 'countColumn', column, label: `COUNT(${column})`, detail: 'Count non-null values' },
      ]),
    ];
  }

  return {
    addProjection,
    projectionExpression,
    projectionKey,
    projectionLabel,
    projectionSuggestions,
    quoteIdentifier,
    reconcileProjections,
    removeProjection,
    serializeProjections,
  };
}));
