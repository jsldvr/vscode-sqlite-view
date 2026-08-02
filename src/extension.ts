import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { convertEncryption, loadCipherDriver, removeBackup } from './cipher';
import { ConnectionManager } from './connections';
import { ConnectionTreeProvider, DatabaseNode, errorMessage } from './connectionTree';
import { DatabaseReference } from './types';
import { WorkbenchProvider } from './workbench';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context);
  const tree = new ConnectionTreeProvider(connections);
  const workbench = new WorkbenchProvider(context, connections, () => tree.refresh());

  context.subscriptions.push(
    connections,
    tree,
    vscode.window.createTreeView('sqliteView.connections', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.registerCustomEditorProvider(WorkbenchProvider.viewType, workbench, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    command('sqliteView.addDatabase', () => addDatabase(connections)),
    command('sqliteView.createDatabase', () => createDatabase(connections)),
    command('sqliteView.openDatabase', (node?: DatabaseNode | DatabaseReference, table?: string) => openDatabase(connections, node, table)),
    command('sqliteView.removeDatabase', (node?: DatabaseNode) => removeDatabase(connections, node)),
    command('sqliteView.renameDatabase', (node?: DatabaseNode) => renameDatabase(connections, node)),
    command('sqliteView.revealDatabase', (node?: DatabaseNode) => revealDatabase(node)),
    command('sqliteView.refresh', () => { connections.refresh(); tree.refresh(); }),
    command('sqliteView.compactDatabase', (node?: DatabaseNode) => compactDatabase(connections, node)),
    command('sqliteView.exportSql', (node?: DatabaseNode) => exportSql(connections, node)),
    command('sqliteView.importSql', (node?: DatabaseNode) => importSql(connections, tree, node)),
    command('sqliteView.changeEncryption', (node?: DatabaseNode) => changeEncryption(connections, tree, node)),
  );
}

export function deactivate(): void {}

function command(name: string, handler: (...args: any[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(name, async (...args: any[]) => {
    try {
      await handler(...args);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  });
}

async function addDatabase(connections: ConnectionManager): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Add Databases',
    filters: { 'SQLite databases': ['db', 'db3', 'sqlite', 'sqlite3'], 'All files': ['*'] },
  });
  if (!selected) return;
  for (const uri of selected) await connections.add(uri.fsPath);
  if (selected.length === 1) await vscode.commands.executeCommand('vscode.openWith', selected[0], WorkbenchProvider.viewType);
}

async function createDatabase(connections: ConnectionManager): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Create Database',
    filters: { 'SQLite database': ['sqlite', 'db'] },
  });
  if (!target) return;
  let exists = false;
  try { await fs.access(target.fsPath); exists = true; } catch { /* new path */ }
  if (exists) {
    const answer = await vscode.window.showWarningMessage('The selected database already exists. Add it without replacing its contents?', { modal: true }, 'Add Existing');
    if (answer !== 'Add Existing') return;
  }
  const reference = await connections.add(target.fsPath);
  const session = await connections.session(reference, !exists);
  if (!exists) await session.exec('PRAGMA user_version = 0');
  await vscode.commands.executeCommand('vscode.openWith', target, WorkbenchProvider.viewType);
}

async function openDatabase(connections: ConnectionManager, input?: DatabaseNode | DatabaseReference, table?: string): Promise<void> {
  const reference = resolveReference(connections, input);
  if (!reference) return addDatabase(connections);
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(reference.path), WorkbenchProvider.viewType);
  if (table) {
    // The editor opens on the first table. Table-specific restoration is intentionally deferred
    // until VS Code exposes the new panel's ready state to this command invocation.
  }
}

async function removeDatabase(connections: ConnectionManager, node?: DatabaseNode): Promise<void> {
  const reference = node?.reference;
  if (!reference) return;
  const answer = await vscode.window.showWarningMessage(`Remove ${reference.name} from the SQLite View library? The database file will not be deleted.`, { modal: true }, 'Remove');
  if (answer === 'Remove') await connections.remove(reference);
}

async function renameDatabase(connections: ConnectionManager, node?: DatabaseNode): Promise<void> {
  if (!node) return;
  const name = await vscode.window.showInputBox({ title: 'Rename Library Entry', value: node.reference.name, validateInput: value => value.trim() ? undefined : 'A name is required.' });
  if (!name) return;
  await connections.update({ ...node.reference, name: name.trim() });
}

async function revealDatabase(node?: DatabaseNode): Promise<void> {
  if (node) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.reference.path));
}

async function compactDatabase(connections: ConnectionManager, node?: DatabaseNode): Promise<void> {
  if (!node) return;
  const answer = await vscode.window.showWarningMessage(`Run VACUUM on ${node.reference.name}? This can temporarily require additional disk space.`, { modal: true }, 'Compact');
  if (answer !== 'Compact') return;
  await (await connections.session(node.reference)).compact();
  void vscode.window.showInformationMessage(`${node.reference.name} compacted.`);
}

async function exportSql(connections: ConnectionManager, node?: DatabaseNode): Promise<void> {
  if (!node) return;
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${node.reference.path}.sql`), filters: { SQL: ['sql'] } });
  if (!target) return;
  await fs.writeFile(target.fsPath, await (await connections.session(node.reference)).dumpSql(), 'utf8');
  void vscode.window.showInformationMessage(`SQL dump saved to ${target.fsPath}.`);
}

async function importSql(connections: ConnectionManager, tree: ConnectionTreeProvider, node?: DatabaseNode): Promise<void> {
  if (!node) return;
  const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQL: ['sql'] } });
  if (!selected?.[0]) return;
  const answer = await vscode.window.showWarningMessage(`Execute every statement in ${path.basename(selected[0].fsPath)} against ${node.reference.name}?`, { modal: true }, 'Import');
  if (answer !== 'Import') return;
  await (await connections.session(node.reference)).importSql(await fs.readFile(selected[0].fsPath, 'utf8'));
  tree.refresh();
}

async function changeEncryption(connections: ConnectionManager, tree: ConnectionTreeProvider, node?: DatabaseNode): Promise<void> {
  if (!node) return;
  if (!loadCipherDriver()) throw new Error('SQLCipher runtime is not available for this platform. Standard SQLite features remain available.');
  const reference = node.reference;
  const choices = reference.encrypted ? ['Change password', 'Remove encryption'] : ['Add encryption'];
  const action = await vscode.window.showQuickPick(choices, { title: `SQLCipher: ${reference.name}` });
  if (!action) return;
  let oldKey = connections.getSessionKey(reference.id);
  if (reference.encrypted && !oldKey) {
    oldKey = await vscode.window.showInputBox({ title: 'Current SQLCipher Password', password: true, ignoreFocusOut: true }) ?? '';
  }
  let newKey = '';
  if (action !== 'Remove encryption') {
    newKey = await vscode.window.showInputBox({ title: 'New SQLCipher Password', password: true, ignoreFocusOut: true, validateInput: value => value.length < 1 ? 'A password is required.' : undefined }) ?? '';
    if (!newKey) return;
    const confirmation = await vscode.window.showInputBox({ title: 'Confirm SQLCipher Password', password: true, ignoreFocusOut: true });
    if (confirmation !== newKey) throw new Error('The passwords do not match.');
  }
  const answer = await vscode.window.showWarningMessage(`${action} for ${reference.name}? SQLite View will create and verify a replacement database before moving the original to a backup.`, { modal: true }, 'Convert');
  if (answer !== 'Convert') return;
  await connections.close(reference.id);
  const timeout = vscode.workspace.getConfiguration('sqliteView').get<number>('busyTimeout', 5000);
  const backup = await convertEncryption(reference.path, oldKey, newKey, timeout);
  const updated = { ...reference, encrypted: Boolean(newKey) };
  connections.setSessionKey(reference.id, newKey);
  await connections.update(updated);
  tree.refresh();
  const backupChoice = await vscode.window.showInformationMessage(`Encryption conversion completed. The original is preserved at ${backup}.`, 'Delete Backup', 'Keep Backup');
  if (backupChoice === 'Delete Backup') {
    const confirmDelete = await vscode.window.showWarningMessage(`Permanently delete ${backup}?`, { modal: true }, 'Delete');
    if (confirmDelete === 'Delete') await removeBackup(backup);
  }
}

function resolveReference(connections: ConnectionManager, input?: DatabaseNode | DatabaseReference): DatabaseReference | undefined {
  if (input instanceof DatabaseNode) return input.reference;
  if (input && typeof input === 'object' && 'id' in input) return connections.find(input.id);
  return undefined;
}
