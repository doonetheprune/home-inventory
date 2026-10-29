/** Stores uploads (photos) as files in a folder, with a small JSON file for each one's details. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, type FileStore, type StoredFile } from '@larder/core';

const SAFE_ID = /^[0-9a-f-]{36}$/;

export function createLocalFileStore(dir: string): FileStore {
  const ready = mkdir(dir, { recursive: true });
  return {
    async put(file: StoredFile) {
      await ready;
      const id = newId();
      await writeFile(join(dir, id), file.data);
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ contentType: file.contentType, name: file.name }));
      return { id };
    },
    async get(id) {
      if (!SAFE_ID.test(id)) return null;
      try {
        const [data, meta] = await Promise.all([readFile(join(dir, id)), readFile(join(dir, `${id}.json`), 'utf8')]);
        const m = JSON.parse(meta) as { contentType: string; name: string };
        return { data: new Uint8Array(data), contentType: m.contentType, name: m.name };
      } catch {
        return null;
      }
    },
    async remove(id) {
      if (!SAFE_ID.test(id)) return;
      await rm(join(dir, id), { force: true });
      await rm(join(dir, `${id}.json`), { force: true });
    },
  };
}
