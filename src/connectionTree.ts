import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { DatabaseReference, SchemaObject } from './types';

type TreeNode = DatabaseNode | GroupNode | ObjectNode | ColumnNode;

export class DatabaseNode extends vscode.TreeItem {
  public constructor(public readonly reference: DatabaseReference) {
    super(reference.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = reference.encrypted ? 'SQLCipher' : undefined;
    this.tooltip = reference.path;
    this.contextValue = 'database';
    this.iconPath = new vscode.ThemeIcon('database');
    this.command = { command: 'sqliteView.openDatabase', title: 'Open Database', arguments: [this] };
  }
}

class GroupNode extends vscode.TreeItem {
  public constructor(public readonly reference: DatabaseReference, public readonly group: SchemaObject['type'], public readonly objects: SchemaObject[]) {
    super(`${group[0].toUpperCase()}${group.slice(1)}s`, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(objects.length);
    this.contextValue = 'schemaGroup';
    this.iconPath = new vscode.ThemeIcon(group === 'table' ? 'table' : group === 'view' ? 'preview' : group === 'index' ? 'list-tree' : 'symbol-event');
  }
}

class ObjectNode extends vscode.TreeItem {
  public constructor(public readonly reference: DatabaseReference, public readonly object: SchemaObject) {
    super(object.name, object.columns ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.description = object.type === 'index' || object.type === 'trigger' ? object.tableName : undefined;
    this.contextValue = `schemaObject.${object.type}`;
    this.iconPath = new vscode.ThemeIcon(object.type === 'table' ? 'table' : object.type === 'view' ? 'preview' : object.type === 'index' ? 'key' : 'symbol-event');
    this.command = object.type === 'table' || object.type === 'view'
      ? { command: 'sqliteView.openDatabase', title: 'Open', arguments: [new DatabaseNode(reference), object.name] }
      : undefined;
  }
}

class ColumnNode extends vscode.TreeItem {
  public constructor(public readonly column: NonNullable<SchemaObject['columns']>[number]) {
    super(column.name, vscode.TreeItemCollapsibleState.None);
    this.description = [column.type, column.primaryKeyOrder ? 'PK' : '', column.notNull ? 'NOT NULL' : ''].filter(Boolean).join(' ');
    this.contextValue = 'column';
    this.iconPath = new vscode.ThemeIcon(column.primaryKeyOrder ? 'key' : 'symbol-field');
  }
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly connections: ConnectionManager) {
    this.subscription = connections.onDidChange(() => this.refresh());
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) return this.connections.list().map(reference => new DatabaseNode(reference));
    if (element instanceof DatabaseNode) {
      try {
        const schema = await (await this.connections.session(element.reference)).schema();
        return (['table', 'view', 'index', 'trigger'] as const).map(type => new GroupNode(element.reference, type, schema.filter(object => object.type === type)));
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
        return [];
      }
    }
    if (element instanceof GroupNode) return element.objects.map(object => new ObjectNode(element.reference, object));
    if (element instanceof ObjectNode) return (element.object.columns ?? []).map(column => new ColumnNode(column));
    return [];
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
