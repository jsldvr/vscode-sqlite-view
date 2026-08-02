(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  let sequence = 0;
  const pending = new Map();
  const state = { schema: [], table: '', page: 0, pageSize: 100, search: '', sort: undefined, pageData: undefined, selectedIndex: -1, resultColumns: [], resultRows: [] };
  const byId = id => document.getElementById(id);

  function request(type, payload = {}) {
    const requestId = ++sequence;
    vscode.postMessage({ type, requestId, ...payload });
    return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type !== 'response') return;
    const handler = pending.get(message.requestId);
    if (!handler) return;
    pending.delete(message.requestId);
    if (message.error) handler.reject(new Error(message.error)); else handler.resolve(message.payload);
  });

  function run(operation, busy = 'Working...') {
    setStatus(busy);
    return operation.then(value => { setStatus('Ready'); return value; }).catch(error => { setStatus('Error'); toast(error.message, true); throw error; });
  }
  function setStatus(text) { byId('status').textContent = text; }
  function toast(text, error = false) {
    const element = byId('toast');
    element.textContent = text;
    element.style.borderColor = error ? 'var(--vscode-errorForeground)' : '';
    element.classList.add('show');
    window.setTimeout(() => element.classList.remove('show'), 4500);
  }
  function clear(element) { while (element.firstChild) element.firstChild.remove(); }
  function textElement(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  function display(value) {
    if (value === null) return 'NULL';
    if (value && value.type === 'blob') return `[BLOB ${value.length} bytes]`;
    return String(value);
  }

  function applySchema(schema) {
    state.schema = schema || [];
    const tables = state.schema.filter(item => item.type === 'table' || item.type === 'view');
    for (const id of ['table-select', 'builder-table']) {
      const select = byId(id); const previous = select.value; clear(select);
      for (const table of tables) { const option = document.createElement('option'); option.value = table.name; option.textContent = `${table.name}${table.type === 'view' ? ' (view)' : ''}`; select.append(option); }
      select.value = tables.some(table => table.name === previous) ? previous : tables[0]?.name || '';
    }
    state.table = byId('table-select').value;
    renderSchema();
  }

  async function loadBrowse(resetPage = false) {
    state.table = byId('table-select').value;
    if (!state.table) { renderGrid({ columns: [], rows: [], totalRows: 0, page: 0, pageSize: state.pageSize, editable: false, locatorColumns: [] }); return; }
    if (resetPage) state.page = 0;
    const page = await run(request('browse', { table: state.table, page: state.page, pageSize: state.pageSize, search: state.search, sort: state.sort }), 'Loading rows...');
    state.pageData = page; state.selectedIndex = -1; renderGrid(page);
  }

  function renderGrid(page) {
    const head = byId('grid').tHead; const body = byId('grid').tBodies[0]; clear(head); clear(body);
    const visible = page.columns.filter(column => column.hidden === 0);
    const headerRow = head.insertRow();
    for (const column of visible) {
      const th = document.createElement('th');
      th.textContent = column.name + (state.sort?.column === column.name ? (state.sort.direction === 'ASC' ? ' ASC' : ' DESC') : '');
      th.title = [column.type, column.primaryKeyOrder ? 'Primary key' : '', column.notNull ? 'Not null' : ''].filter(Boolean).join(', ');
      th.addEventListener('click', () => { state.sort = { column: column.name, direction: state.sort?.column === column.name && state.sort.direction === 'ASC' ? 'DESC' : 'ASC' }; void loadBrowse(true); });
      headerRow.append(th);
    }
    page.rows.forEach((row, index) => {
      const tr = body.insertRow();
      tr.addEventListener('click', () => { [...body.rows].forEach(item => item.classList.remove('selected')); tr.classList.add('selected'); state.selectedIndex = index; byId('delete-row').disabled = !page.editable; });
      tr.addEventListener('dblclick', () => page.editable && openRowDialog(false, row));
      for (const column of visible) {
        const td = tr.insertCell(); const value = row[column.name]; td.textContent = display(value); td.title = display(value); if (value === null) td.className = 'null';
      }
    });
    const start = page.totalRows === 0 ? 0 : page.page * page.pageSize + 1;
    const end = Math.min(page.totalRows, (page.page + 1) * page.pageSize);
    byId('page-info').textContent = `${start}-${end} of ${page.totalRows}`;
    byId('previous').disabled = page.page === 0;
    byId('next').disabled = end >= page.totalRows;
    byId('add-row').disabled = !page.editable;
    byId('delete-row').disabled = true;
  }

  function rowLocator(row) {
    return Object.fromEntries(state.pageData.locatorColumns.map(column => [column, row[column]]));
  }
  function openRowDialog(inserting, row = {}) {
    const dialog = byId('row-dialog'); const fields = byId('row-fields'); clear(fields);
    byId('row-dialog-title').textContent = inserting ? `Add row to ${state.table}` : `Edit row in ${state.table}`;
    for (const column of state.pageData.columns.filter(item => item.hidden === 0)) {
      const wrapper = document.createElement('label'); wrapper.className = 'field';
      wrapper.append(textElement('span', column.name));
      const input = document.createElement('input'); input.dataset.column = column.name; input.value = row[column.name] === null || row[column.name] === undefined || row[column.name]?.type === 'blob' ? '' : String(row[column.name]); input.disabled = row[column.name]?.type === 'blob'; wrapper.append(input);
      const nullLabel = textElement('label', ' NULL'); const nullBox = document.createElement('input'); nullBox.type = 'checkbox'; nullBox.dataset.nullFor = column.name; nullBox.checked = !inserting && row[column.name] === null; nullBox.addEventListener('change', () => input.disabled = nullBox.checked || row[column.name]?.type === 'blob'); nullLabel.prepend(nullBox); wrapper.append(nullLabel); fields.append(wrapper);
    }
    dialog.dataset.mode = inserting ? 'insert' : 'update'; dialog.dataset.rowIndex = String(state.selectedIndex); dialog.showModal();
  }
  async function saveRow(event) {
    event.preventDefault();
    const dialog = byId('row-dialog'); const values = {};
    for (const input of dialog.querySelectorAll('input[data-column]')) {
      if (input.disabled && !dialog.querySelector(`[data-null-for="${CSS.escape(input.dataset.column)}"]`)?.checked) continue;
      const nullBox = dialog.querySelector(`[data-null-for="${CSS.escape(input.dataset.column)}"]`);
      values[input.dataset.column] = nullBox.checked ? null : input.value;
    }
    if (dialog.dataset.mode === 'insert') await run(request('insert', { table: state.table, values }), 'Adding row...');
    else { const row = state.pageData.rows[Number(dialog.dataset.rowIndex)]; await run(request('update', { table: state.table, values, locator: rowLocator(row) }), 'Saving row...'); }
    dialog.close(); await loadBrowse(); toast('Row saved.');
  }

  async function deleteSelected() {
    if (state.selectedIndex < 0) return;
    const row = state.pageData.rows[state.selectedIndex];
    if (!confirm(`Delete the selected row from ${state.table}?`)) return;
    await run(request('delete', { table: state.table, locator: rowLocator(row) }), 'Deleting row...'); await loadBrowse(); toast('Row deleted.');
  }

  async function executeSql() {
    const sql = byId('sql-editor').value;
    const results = await run(request('execute', { sql }), 'Executing SQL...');
    renderResults(results);
    if (results.some(result => !/^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i.test(result.statement))) {
      const init = await request('schema'); applySchema(init.schema); await loadBrowse();
    }
  }
  function renderResults(results) {
    const container = byId('query-results'); clear(container);
    for (const result of results) {
      const block = document.createElement('div'); block.className = 'result-block';
      block.append(textElement('div', `${result.rows.length} rows, ${result.changes} changes, ${result.elapsedMs.toFixed(1)} ms${result.truncated ? ', truncated' : ''}`, 'result-meta'));
      if (result.columns.length) block.append(buildTable(result.columns, result.rows));
      container.append(block);
    }
    const lastRows = [...results].reverse().find(result => result.rows.length > 0);
    if (lastRows) { state.resultColumns = lastRows.columns; state.resultRows = lastRows.rows; populateChartColumns(); }
  }
  function buildTable(columns, rows) {
    const table = document.createElement('table'); const head = table.createTHead().insertRow(); const body = table.createTBody();
    columns.forEach(column => head.append(textElement('th', column)));
    rows.forEach(row => { const tr = body.insertRow(); columns.forEach(column => { const td = tr.insertCell(); td.textContent = display(row[column]); }); });
    return table;
  }

  function renderSchema() {
    const container = byId('schema-list'); clear(container);
    for (const object of state.schema) {
      const details = document.createElement('details'); details.className = 'schema-object';
      const summary = document.createElement('summary'); summary.textContent = `${object.type.toUpperCase()} ${object.name}`; details.append(summary);
      if (object.columns) {
        const columns = textElement('p', object.columns.map(column => `${column.name} ${column.type}${column.primaryKeyOrder ? ' PK' : ''}${column.notNull ? ' NOT NULL' : ''}`).join(', ')); columns.style.padding = '0 10px'; details.append(columns);
      }
      details.append(textElement('pre', object.sql || '(implicit object)'));
      if (object.sql) { const actions = document.createElement('div'); actions.className = 'schema-actions'; if (object.type === 'table') { const modify = textElement('button', 'Modify table'); modify.addEventListener('click', () => openAlterDialog(object)); actions.append(modify); } const drop = textElement('button', `Drop ${object.type}`, 'danger'); drop.addEventListener('click', () => dropObject(object)); actions.append(drop); details.append(actions); }
      container.append(details);
    }
  }
  async function dropObject(object) {
    try { const result = await run(request('dropObject', { objectType: object.type, name: object.name }), `Dropping ${object.name}...`); applySchema(result.schema); await loadBrowse(true); toast(`${object.name} dropped.`); } catch (_) { /* error already shown */ }
  }

  function openTableDialog() {
    const dialog = byId('schema-dialog'); byId('schema-dialog-title').textContent = 'Create table'; dialog.dataset.mode = 'table'; const fields = byId('schema-fields'); clear(fields);
    const name = document.createElement('input'); name.id = 'new-table-name'; name.placeholder = 'Table name'; fields.append(name);
    const columns = document.createElement('div'); columns.id = 'new-columns'; fields.append(columns); addColumnDefinition();
    const add = textElement('button', 'Add column'); add.type = 'button'; add.addEventListener('click', addColumnDefinition); fields.append(add); dialog.showModal();
  }
  function addColumnDefinition() {
    const container = byId('new-columns'); const row = document.createElement('div'); row.className = 'column-definition';
    const name = document.createElement('input'); name.placeholder = 'Name'; name.dataset.role = 'name'; const type = document.createElement('input'); type.placeholder = 'Type'; type.value = 'TEXT'; type.dataset.role = 'type'; row.append(name, type);
    for (const [role, label] of [['primaryKey', 'PK'], ['notNull', 'Not null'], ['unique', 'Unique']]) { const wrapper = textElement('label', label); const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.role = role; wrapper.prepend(box); row.append(wrapper); }
    const value = document.createElement('input'); value.placeholder = 'Default expression'; value.dataset.role = 'defaultExpression'; row.append(value); container.append(row);
  }
  function openIndexDialog() {
    if (!state.schema.some(item => item.type === 'table')) return toast('Create a table first.', true);
    const dialog = byId('schema-dialog'); byId('schema-dialog-title').textContent = 'Create index'; dialog.dataset.mode = 'index'; const fields = byId('schema-fields'); clear(fields);
    const name = document.createElement('input'); name.id = 'new-index-name'; name.placeholder = 'Index name';
    const table = document.createElement('select'); table.id = 'new-index-table'; state.schema.filter(item => item.type === 'table').forEach(item => { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; table.append(option); });
    const columns = document.createElement('input'); columns.id = 'new-index-columns'; columns.placeholder = 'Columns, comma separated';
    const uniqueLabel = textElement('label', ' Unique'); const unique = document.createElement('input'); unique.type = 'checkbox'; unique.id = 'new-index-unique'; uniqueLabel.prepend(unique); fields.append(name, table, columns, uniqueLabel); dialog.showModal();
  }
  function openAlterDialog(table) {
    const dialog = byId('schema-dialog'); byId('schema-dialog-title').textContent = `Modify ${table.name}`; dialog.dataset.mode = 'alter'; dialog.dataset.table = table.name; const fields = byId('schema-fields'); clear(fields);
    const action = document.createElement('select'); action.id = 'alter-action';
    [['renameTable', 'Rename table'], ['addColumn', 'Add column'], ['renameColumn', 'Rename column'], ['dropColumn', 'Drop column']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; action.append(option); });
    const controls = document.createElement('div'); controls.id = 'alter-controls'; fields.append(action, controls);
    const redraw = () => {
      clear(controls); const mode = action.value;
      if (mode === 'renameTable') { const input = document.createElement('input'); input.id = 'alter-new-name'; input.placeholder = 'New table name'; controls.append(input); }
      if (mode === 'addColumn') { const row = document.createElement('div'); row.className = 'column-definition'; const name = document.createElement('input'); name.id = 'alter-column-name'; name.placeholder = 'Column name'; const type = document.createElement('input'); type.id = 'alter-column-type'; type.placeholder = 'Type'; type.value = 'TEXT'; const notNullLabel = textElement('label', ' Not null'); const notNull = document.createElement('input'); notNull.type = 'checkbox'; notNull.id = 'alter-not-null'; notNullLabel.prepend(notNull); const defaultValue = document.createElement('input'); defaultValue.id = 'alter-default'; defaultValue.placeholder = 'Default expression'; row.append(name, type, notNullLabel, defaultValue); controls.append(row); }
      if (mode === 'renameColumn' || mode === 'dropColumn') { const column = document.createElement('select'); column.id = 'alter-column'; table.columns.filter(item => item.hidden === 0).forEach(item => { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; column.append(option); }); controls.append(column); if (mode === 'renameColumn') { const input = document.createElement('input'); input.id = 'alter-new-name'; input.placeholder = 'New column name'; controls.append(input); } }
    };
    action.addEventListener('change', redraw); redraw(); dialog.showModal();
  }
  async function saveSchema(event) {
    event.preventDefault(); const dialog = byId('schema-dialog');
    if (dialog.dataset.mode === 'table') {
      const columns = [...document.querySelectorAll('.column-definition')].map(row => Object.fromEntries([...row.querySelectorAll('[data-role]')].map(input => [input.dataset.role, input.type === 'checkbox' ? input.checked : input.value])));
      const result = await run(request('createTable', { name: byId('new-table-name').value, columns }), 'Creating table...'); applySchema(result.schema);
    } else if (dialog.dataset.mode === 'index') {
      const result = await run(request('createIndex', { name: byId('new-index-name').value, table: byId('new-index-table').value, columns: byId('new-index-columns').value.split(',').map(value => value.trim()).filter(Boolean), unique: byId('new-index-unique').checked }), 'Creating index...'); applySchema(result.schema);
    } else {
      const action = byId('alter-action').value; const payload = { table: dialog.dataset.table, action };
      if (action === 'renameTable') payload.newName = byId('alter-new-name').value;
      if (action === 'addColumn') payload.column = { name: byId('alter-column-name').value, type: byId('alter-column-type').value, notNull: byId('alter-not-null').checked, defaultExpression: byId('alter-default').value };
      if (action === 'renameColumn') { payload.column = byId('alter-column').value; payload.newName = byId('alter-new-name').value; }
      if (action === 'dropColumn') payload.column = byId('alter-column').value;
      const result = await run(request('alterTable', payload), 'Modifying table...'); applySchema(result.schema);
    }
    dialog.close(); await loadBrowse(true); toast('Schema updated.');
  }

  function buildQuery() {
    const table = byId('builder-table').value.replaceAll('"', '""'); const columns = byId('builder-columns').value || '*';
    const where = byId('builder-where').value.trim(); const order = byId('builder-order').value.trim(); const limit = Math.max(1, Number(byId('builder-limit').value) || 100);
    byId('sql-editor').value = `SELECT ${columns}\nFROM "${table}"${where ? `\nWHERE ${where}` : ''}${order ? `\nORDER BY ${order}` : ''}\nLIMIT ${limit};`;
  }

  function populateChartColumns() {
    for (const id of ['chart-label', 'chart-value']) { const select = byId(id); clear(select); state.resultColumns.forEach(column => { const option = document.createElement('option'); option.value = column; option.textContent = column; select.append(option); }); }
    const numeric = state.resultColumns.find(column => state.resultRows.some(row => Number.isFinite(Number(row[column])))); if (numeric) byId('chart-value').value = numeric;
  }
  function drawChart() {
    const labelKey = byId('chart-label').value; const valueKey = byId('chart-value').value; const data = state.resultRows.slice(0, 50).map(row => ({ label: display(row[labelKey]), value: Number(row[valueKey]) })).filter(item => Number.isFinite(item.value));
    if (!data.length) return toast('No numeric query data is available.', true);
    byId('chart-empty').hidden = true; const canvas = byId('chart-canvas'); const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height);
    const styles = getComputedStyle(document.body); const foreground = styles.getPropertyValue('--vscode-foreground'); const accent = styles.getPropertyValue('--vscode-charts-blue') || '#3794ff'; const max = Math.max(...data.map(item => Math.abs(item.value)), 1); const chartHeight = canvas.height - 70; const barWidth = Math.max(3, (canvas.width - 60) / data.length - 4);
    context.fillStyle = foreground; context.font = '11px sans-serif'; data.forEach((item, index) => { const height = Math.abs(item.value) / max * chartHeight; const x = 50 + index * (barWidth + 4); context.fillStyle = accent; context.fillRect(x, chartHeight - height + 20, barWidth, height); context.save(); context.translate(x + barWidth / 2, canvas.height - 5); context.rotate(-Math.PI / 4); context.fillStyle = foreground; context.fillText(item.label.slice(0, 18), 0, 0); context.restore(); });
  }

  async function loadLogs() {
    const logs = await run(request('logs'), 'Loading log...'); const container = byId('log-list'); clear(container);
    logs.forEach(log => { const entry = document.createElement('div'); entry.className = `log-entry ${log.status}`; entry.append(textElement('div', `${log.timestamp} | ${log.elapsedMs.toFixed(1)} ms | ${log.status.toUpperCase()}`, 'log-meta'), textElement('div', log.sql)); if (log.params.length) entry.append(textElement('div', `Parameters: ${JSON.stringify(log.params)}`, 'log-meta')); if (log.error) entry.append(textElement('div', log.error)); container.append(entry); });
  }

  function bind() {
    byId('tabs').addEventListener('click', event => { const button = event.target.closest('button[data-tab]'); if (!button) return; document.querySelectorAll('#tabs button,.tab').forEach(element => element.classList.remove('active')); button.classList.add('active'); byId(button.dataset.tab).classList.add('active'); if (button.dataset.tab === 'log') void loadLogs(); });
    byId('table-select').addEventListener('change', () => void loadBrowse(true));
    byId('refresh').addEventListener('click', () => void loadBrowse());
    let searchTimer; byId('search').addEventListener('input', event => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = event.target.value; void loadBrowse(true); }, 300); });
    byId('previous').addEventListener('click', () => { state.page -= 1; void loadBrowse(); }); byId('next').addEventListener('click', () => { state.page += 1; void loadBrowse(); });
    byId('add-row').addEventListener('click', () => openRowDialog(true)); byId('delete-row').addEventListener('click', () => void deleteSelected()); byId('save-row').addEventListener('click', event => void saveRow(event));
    byId('run-sql').addEventListener('click', () => void executeSql()); byId('clear-sql').addEventListener('click', () => byId('sql-editor').value = ''); byId('sql-editor').addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void executeSql(); } }); byId('build-query').addEventListener('click', buildQuery);
    byId('create-table').addEventListener('click', openTableDialog); byId('create-index').addEventListener('click', openIndexDialog); byId('save-schema').addEventListener('click', event => void saveSchema(event));
    byId('export-csv').addEventListener('click', () => void run(request('exportCsv', { table: state.table }), 'Exporting CSV...').then(result => result.saved && toast('CSV exported.'))); byId('import-csv').addEventListener('click', () => void run(request('importCsv', { table: state.table }), 'Importing CSV...').then(result => { if (!result.cancelled) { toast(`${result.imported} rows imported.`); void loadBrowse(); } }));
    byId('export-sql').addEventListener('click', () => void run(request('exportSql'), 'Exporting SQL...').then(result => result.saved && toast('SQL dump exported.'))); byId('import-sql').addEventListener('click', () => void run(request('importSql'), 'Importing SQL...').then(result => { if (result.imported) { toast('SQL dump imported.'); void request('schema').then(init => { applySchema(init.schema); void loadBrowse(true); }); } }));
    byId('compact').addEventListener('click', () => void run(request('compact'), 'Compacting database...').then(() => toast('Database compacted.')));
    byId('draw-chart').addEventListener('click', drawChart); byId('refresh-log').addEventListener('click', () => void loadLogs()); byId('clear-log').addEventListener('click', () => void run(request('clearLogs')).then(loadLogs));
  }

  bind();
  run(request('ready'), 'Opening database...').then(init => { applySchema(init.schema); return loadBrowse(true); }).catch(() => undefined);
}());
