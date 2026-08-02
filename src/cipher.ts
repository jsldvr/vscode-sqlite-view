import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { DatabaseSession } from './database';

const runtimeRequire = createRequire(__filename);

export function loadCipherDriver(): typeof sqlite3 | undefined {
  try {
    // Optional because not every platform ships a compatible SQLCipher binary.
    return runtimeRequire('@journeyapps/sqlcipher') as typeof sqlite3;
  } catch {
    return undefined;
  }
}

export async function convertEncryption(
  filePath: string,
  oldKey: string,
  newKey: string,
  busyTimeout: number,
): Promise<string> {
  const driver = loadCipherDriver();
  if (!driver) throw new Error('SQLCipher is unavailable for this platform. Install a SQLite View build containing the optional SQLCipher runtime.');

  const suffix = `${Date.now()}-${process.pid}`;
  const temporaryPath = `${filePath}.sqlite-view-${suffix}.tmp`;
  const backupPath = `${filePath}.sqlite-view-${suffix}.backup`;
  const source = new DatabaseSession(filePath, busyTimeout, driver, oldKey);
  let movedOriginal = false;
  try {
    await source.open(false);
    const escapedPath = temporaryPath.replaceAll("'", "''");
    const keyHex = Buffer.from(newKey, 'utf8').toString('hex');
    await source.exec(`ATTACH DATABASE '${escapedPath}' AS encrypted KEY "x'${keyHex}'"`);
    await source.get('SELECT sqlcipher_export(?) AS result', ['encrypted']);
    await source.exec('DETACH DATABASE encrypted');
    await source.close();

    const verifier = new DatabaseSession(temporaryPath, busyTimeout, driver, newKey);
    await verifier.open(false);
    await verifier.close();

    await fs.rename(filePath, backupPath);
    movedOriginal = true;
    await fs.rename(temporaryPath, filePath);
    return backupPath;
  } catch (error) {
    await source.close().catch(() => undefined);
    if (movedOriginal) {
      await fs.rename(filePath, temporaryPath).catch(() => undefined);
      await fs.rename(backupPath, filePath).catch(() => undefined);
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeBackup(backupPath: string): Promise<void> {
  if (!path.basename(backupPath).includes('.sqlite-view-') || !backupPath.endsWith('.backup')) {
    throw new Error('Refusing to remove an unrecognized backup path.');
  }
  await fs.rm(backupPath, { force: true });
}
