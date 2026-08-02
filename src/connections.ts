import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DatabaseSession } from './database';
import { loadCipherDriver } from './cipher';
import { DatabaseReference } from './types';

const STORAGE_KEY = 'sqliteView.connections.v1';

export class ConnectionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, DatabaseSession>();
  private readonly sessionKeys = new Map<string, string>();
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changedEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public list(): DatabaseReference[] {
    return this.context.globalState.get<DatabaseReference[]>(STORAGE_KEY, []);
  }

  public async add(filePath: string, encrypted = false): Promise<DatabaseReference> {
    const normalized = path.resolve(filePath);
    const existing = this.list().find(reference => path.normalize(reference.path).toLowerCase() === path.normalize(normalized).toLowerCase());
    if (existing) return existing;
    const reference: DatabaseReference = { id: randomUUID(), name: path.basename(normalized), path: normalized, encrypted };
    await this.context.globalState.update(STORAGE_KEY, [...this.list(), reference]);
    this.changedEmitter.fire();
    return reference;
  }

  public async update(reference: DatabaseReference): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, this.list().map(item => item.id === reference.id ? reference : item));
    this.changedEmitter.fire();
  }

  public async remove(reference: DatabaseReference): Promise<void> {
    await this.close(reference.id);
    await this.context.globalState.update(STORAGE_KEY, this.list().filter(item => item.id !== reference.id));
    this.changedEmitter.fire();
  }

  public find(id: string): DatabaseReference | undefined {
    return this.list().find(reference => reference.id === id);
  }

  public async session(reference: DatabaseReference, create = false): Promise<DatabaseSession> {
    const existing = this.sessions.get(reference.id);
    if (existing) return existing;
    const timeout = vscode.workspace.getConfiguration('sqliteView').get<number>('busyTimeout', 5000);
    let key = this.sessionKeys.get(reference.id);
    if (reference.encrypted && key === undefined) key = await this.requestKey(reference);
    const driver = reference.encrypted ? loadCipherDriver() : undefined;
    if (reference.encrypted && !driver) throw new Error('SQLCipher runtime is not available for this platform.');
    const session = new DatabaseSession(reference.path, timeout, driver, key);
    try {
      await session.open(create);
    } catch (error) {
      if (!reference.encrypted && !create && looksEncrypted(error)) {
        key = await this.requestKey(reference);
        const cipher = loadCipherDriver();
        if (!cipher) throw new Error('This database may be encrypted, but the SQLCipher runtime is unavailable.');
        const encryptedSession = new DatabaseSession(reference.path, timeout, cipher, key);
        await encryptedSession.open(false);
        reference.encrypted = true;
        await this.update(reference);
        this.sessions.set(reference.id, encryptedSession);
        return encryptedSession;
      }
      throw error;
    }
    this.sessions.set(reference.id, session);
    return session;
  }

  public async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) await session.close();
  }

  public setSessionKey(id: string, key: string): void {
    this.sessionKeys.set(id, key);
  }

  public getSessionKey(id: string): string {
    return this.sessionKeys.get(id) ?? '';
  }

  public refresh(): void {
    this.changedEmitter.fire();
  }

  public async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.close().catch(() => undefined)));
    this.sessions.clear();
    this.sessionKeys.clear();
    this.changedEmitter.dispose();
  }

  private async requestKey(reference: DatabaseReference): Promise<string> {
    const key = await vscode.window.showInputBox({
      title: `Unlock ${reference.name}`,
      prompt: 'Enter the SQLCipher password. It is retained in memory only for this VS Code session.',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) throw new Error('Database unlock was cancelled.');
    this.sessionKeys.set(reference.id, key);
    return key;
  }
}

function looksEncrypted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a database|file is encrypted/i.test(message);
}
