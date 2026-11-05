/**
 * Offline copies kept on this device, in IndexedDB: a small record per copy
 * (for the list) and the copy itself, gzipped where the browser can.
 */
import { isOfflineCopy, type OfflineCopy } from './copy';

export interface CopyInfo {
  id: string;
  savedAt: string;
  larderVersion: string;
  household: string;
  /** Items in stock lists (not the wish list), and places. */
  items: number;
  places: number;
  /** Space it takes on the device. */
  bytes: number;
  /** Saved by the daily copy rather than by hand. */
  auto: boolean;
}

interface Stored { id: string; gzip?: ArrayBuffer; json?: string }

const DB = 'larder-offline';
const INFO = 'copies';
const DATA = 'data';

let opened: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(INFO, { keyPath: 'id' });
      req.result.createObjectStore(DATA, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("This browser won't keep copies (it may be in private mode)."));
  }).catch((err: unknown) => {
    opened = null;
    throw err;
  });
  return opened;
}

async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  const t = (await db()).transaction(stores, mode);
  const req = fn(t);
  return new Promise<T>((resolve, reject) => {
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = () => reject(t.error ?? new Error('Saving on this device failed.'));
    t.onabort = () => reject(t.error ?? new Error('There may not be enough space on this device.'));
  });
}

const canGzip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pack(json: string): Promise<Omit<Stored, 'id'>> {
  if (!canGzip()) return { json };
  return { gzip: await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer() };
}

async function unpack(s: Stored): Promise<string> {
  if (s.json !== undefined) return s.json;
  return new Response(new Blob([s.gzip!]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

/** Newest first. */
export async function listCopies(): Promise<CopyInfo[]> {
  const all = await run<CopyInfo[]>([INFO], 'readonly', (t) => t.objectStore(INFO).getAll());
  return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Saves a copy; `info.bytes` is filled in. */
export async function putCopy(info: Omit<CopyInfo, 'bytes'>, json: string): Promise<CopyInfo> {
  const data = await pack(json);
  const full: CopyInfo = { ...info, bytes: data.gzip?.byteLength ?? data.json!.length * 2 };
  await run([INFO, DATA], 'readwrite', (t) => {
    t.objectStore(DATA).put({ id: info.id, ...data });
    t.objectStore(INFO).put(full);
  });
  return full;
}

export async function readCopy(id: string): Promise<OfflineCopy | null> {
  const s = await run<Stored | undefined>([DATA], 'readonly', (t) => t.objectStore(DATA).get(id));
  if (!s) return null;
  const copy = JSON.parse(await unpack(s)) as unknown;
  return isOfflineCopy(copy) ? copy : null;
}

export async function removeCopy(id: string): Promise<void> {
  await run([INFO, DATA], 'readwrite', (t) => {
    t.objectStore(INFO).delete(id);
    t.objectStore(DATA).delete(id);
  });
}

export async function removeAllCopies(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await run([INFO, DATA], 'readwrite', (t) => {
    t.objectStore(INFO).clear();
    t.objectStore(DATA).clear();
  });
}
