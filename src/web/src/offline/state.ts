/**
 * Offline copies: saving them, opening one instead of the live Larder, and
 * the daily copy. See docs/DECISIONS.md ("Offline copies").
 */
import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { answerer } from './copy';
import { openCopy, setOpenCopy } from './current';
import { listCopies, putCopy, readCopy, removeAllCopies, removeCopy, type CopyInfo } from './store';

/** Copies kept on a device; older ones go when a new one is saved. */
export const KEEP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_KEY = 'larder.offline.daily';
const TRIED_KEY = 'larder.offline.tried';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // Private mode: the setting lasts until the page closes.
  }
};

/**
 * Whether Larder can open on this device with no connection:
 * - "frame": inside Home Assistant (its app has to reach Home Assistant before it shows Larder);
 * - "insecure": an http address (browsers only keep apps for https ones);
 * - "unsupported": the browser can't.
 */
export type OfflineSupport = 'ok' | 'frame' | 'insecure' | 'unsupported';
export function offlineSupport(): OfflineSupport {
  if (!('serviceWorker' in navigator) || typeof indexedDB === 'undefined') return 'unsupported';
  try {
    if (window.top !== window.self) return 'frame';
  } catch {
    return 'frame';
  }
  return window.isSecureContext ? 'ok' : 'insecure';
}

/** Keeps the app itself on the device (dist/web/sw.js), where that's possible and useful. */
export function keepAppOnDevice() {
  if (offlineSupport() !== 'ok') return;
  const register = () => navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without it Larder still works; it just won't open with no connection.
  });
  // After the page has loaded, so it doesn't slow the first screen down.
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

/** Save a copy each day? On by default where the copies can be opened with no connection. */
export function dailyCopies(): boolean {
  const v = read(DAILY_KEY);
  return v === null ? offlineSupport() === 'ok' : v === 'on';
}
export function setDailyCopies(on: boolean) {
  write(DAILY_KEY, on ? 'on' : 'off');
}

/** Saves a copy of everything the app shows on this device, and keeps the newest KEEP. */
export async function saveCopy(auto: boolean): Promise<CopyInfo> {
  const copy = await api.offline.copy();
  const r = copy.responses;
  const status = r['/auth/status'] as { user?: { id: string } } | undefined;
  const info = await putCopy({
    id: `${copy.savedAt}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: copy.savedAt,
    larderVersion: copy.larderVersion,
    household: (r['/settings'] as { householdName?: string } | undefined)?.householdName ?? 'Larder',
    items: Array.isArray(r['/products?status=all']) ? r['/products?status=all'].length : 0,
    places: Array.isArray(r['/places']) ? r['/places'].length : 0,
    auto,
  }, JSON.stringify(copy));
  // Remember whose copies these are, so a different person signing in doesn't see them.
  if (status?.user) write(OWNER_KEY, status.user.id);
  for (const old of (await listCopies()).slice(KEEP)) await removeCopy(old.id);
  return info;
}

/** Shows this copy instead of the live Larder. */
export async function showCopy(info: CopyInfo, qc: QueryClient) {
  const copy = await readCopy(info.id);
  if (!copy) throw new Error('That copy is no longer on this device.');
  setOpenCopy({ info, answer: answerer(copy) });
  await qc.resetQueries();
}

/** Back to the live Larder. */
export async function leaveCopy(qc: QueryClient) {
  setOpenCopy(null);
  await qc.resetQueries();
}

const OWNER_KEY = 'larder.offline.user';

/** Who the copies on this device belong to (the Larder account id), if anyone. */
export const copiesOwner = () => read(OWNER_KEY);

/** Removes every copy from this device (on signing out, or when someone else signs in). */
export async function forgetCopies() {
  await removeAllCopies().catch(() => {});
  write(OWNER_KEY, null);
  write(TRIED_KEY, null);
}

/**
 * The daily copy: while the live Larder is open, saves a copy if the newest is
 * over a day old (checked when the app opens and whenever it comes back on
 * screen). After a failed try it waits an hour.
 */
export function useDailyCopy(active: boolean, onSaved: () => void) {
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let stopped = false;
    const check = async () => {
      if (stopped || !dailyCopies() || document.visibilityState !== 'visible' || openCopy()) return;
      if (Date.now() - Number(read(TRIED_KEY) ?? 0) < DAY_MS / 24) return;
      const newest = (await listCopies().catch(() => []))[0];
      if (newest && Date.now() - Date.parse(newest.savedAt) < DAY_MS) return;
      write(TRIED_KEY, String(Date.now()));
      try {
        await saveCopy(true);
        onSaved();
      } catch {
        // Tried again in an hour, or by hand from Settings.
      }
    };
    // After the app has loaded what's on screen.
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), 4000);
    };
    soon();
    const onVisible = () => document.visibilityState === 'visible' && soon();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, onSaved]);
}
