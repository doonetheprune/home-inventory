/**
 * The saved copy the app is showing instead of the live Larder, if any.
 * Kept apart from the rest of offline/ so api.ts can ask without a loop.
 */
import { useSyncExternalStore } from 'react';
import type { CopyInfo } from './store';

export interface OpenCopy {
  info: CopyInfo;
  /** The answer to an API request, from the copy (throws an ApiError when it has none). */
  answer(method: string, path: string): unknown;
}

let open: OpenCopy | null = null;
const listeners = new Set<() => void>();

export const openCopy = (): OpenCopy | null => open;

export function setOpenCopy(copy: OpenCopy | null) {
  open = copy;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The copy being shown, or null for the live Larder. */
export function useOpenCopy(): OpenCopy | null {
  return useSyncExternalStore(subscribe, openCopy);
}
