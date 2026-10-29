/** Keeps uploads in memory. For tests. */
import { newId, type FileStore, type StoredFile } from '@larder/core';

export function createMemoryFileStore(): FileStore {
  const files = new Map<string, StoredFile>();
  return {
    async put(file) {
      const id = newId();
      files.set(id, { ...file, data: new Uint8Array(file.data) });
      return { id };
    },
    async get(id) {
      return files.get(id) ?? null;
    },
    async remove(id) {
      files.delete(id);
    },
  };
}
