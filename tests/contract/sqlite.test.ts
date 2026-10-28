import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteStorage } from '../../src/adapters/storage-sqlite';
import { storageContract } from './storage-contract';

storageContract('SQLite (in memory)', () => createSqliteStorage({ path: ':memory:' }));
storageContract('SQLite (file)', () => createSqliteStorage({ path: join(mkdtempSync(join(tmpdir(), 'larder-')), 'larder.db') }));

describe('SQLite extras', () => {
  it('keeps data across restarts and writes backups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'larder-'));
    const path = join(dir, 'larder.db');
    const a = createSqliteStorage({ path });
    await a.settings.set('x', 1);
    const backup = await a.backup!(join(dir, 'backups'));
    await a.close();
    expect(existsSync(backup)).toBe(true);
    const b = createSqliteStorage({ path });
    expect(await b.settings.get('x')).toBe(1);
    await b.close();
    const c = createSqliteStorage({ path: backup });
    expect(await c.settings.get('x')).toBe(1);
    await c.close();
  });
});
