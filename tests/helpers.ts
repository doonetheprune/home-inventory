/** Builds a core on in-memory adapters with a fixed clock, for fast tests. */
import { createCore, type CoreApi, type ModuleDefinition, type Storage } from '@larder/core';
import { createMemoryStorage } from '../src/adapters/storage-memory';
import { createMemoryFileStore } from '../src/adapters/files-memory';
import { createMemorySearchIndex } from '../src/adapters/search-memory';
import { createMemoryEventBus } from '../src/adapters/events-memory';

export interface TestCore extends CoreApi {
  clock: { set(iso: string): void };
  events: CoreApi['events'] & { log: Array<{ type: string; data: Record<string, unknown> }> };
}

export async function makeCore(options: { modules?: ModuleDefinition[]; storage?: Storage; now?: string } = {}): Promise<TestCore> {
  let now = new Date(options.now ?? '2026-10-28T09:00:00.000Z');
  const bus = createMemoryEventBus((err) => {
    throw err;
  });
  const log: Array<{ type: string; data: Record<string, unknown> }> = [];
  bus.subscribe((e) => log.push({ type: e.type, data: e.data }));
  const core = await createCore(
    { storage: options.storage ?? createMemoryStorage(), files: createMemoryFileStore(), search: createMemorySearchIndex(), events: bus, clock: { now: () => now }, lookupTimeoutMs: 200 },
    { modules: options.modules ?? [] },
  );
  return Object.assign(core, {
    clock: { set: (iso: string) => (now = new Date(iso)) },
    events: Object.assign(core.events, { log }),
  });
}

export async function category(core: CoreApi, name: string) {
  const c = (await core.categories.list()).find((x) => x.name === name);
  if (!c) throw new Error(`No category ${name}`);
  return c;
}
