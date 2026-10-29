import { z } from 'zod';
import type { Clock, EventBus, FileStore, HomeAssistantPort, SearchIndex, Storage } from '../ports';
import { isoNow, localDate } from '../util';

export const HouseholdSettings = z.object({
  householdName: z.string().max(80).default('Our house'),
  /** Days before expiry to warn, unless a category says otherwise. */
  expiryWarningDays: z.number().int().min(0).max(365).default(7),
  currency: z.string().length(3).default('GBP'),
  timeZone: z.string().max(60).default('Europe/London'),
});
export type HouseholdSettings = z.infer<typeof HouseholdSettings>;

export interface CoreDeps {
  storage: Storage;
  files: FileStore;
  search: SearchIndex;
  events: EventBus;
  clock?: Clock;
  /** How long to wait for each barcode lookup provider (and for a lookup's photo). */
  lookupTimeoutMs?: number;
  /** For lookups and other web services (photos, maps). Defaults to the platform's fetch; tests pass their own. */
  fetch?: typeof fetch;
  /** Home Assistant, when Larder can reach it. */
  homeAssistant?: HomeAssistantPort | null;
}

/** Shared by every service. */
export interface CoreContext extends Required<Omit<CoreDeps, 'clock' | 'fetch' | 'homeAssistant'>> {
  fetch: typeof fetch;
  homeAssistant: HomeAssistantPort | null;
  clock: Clock;
  now(): string;
  today(): string;
  household(): Promise<HouseholdSettings>;
  publish(type: string, data: Record<string, unknown>): void;
  /**
   * Runs changes one at a time. Stock and product writes read, work out the
   * change and write it back; two at once (two automations, two taps) would
   * otherwise both start from the same stock and one would be lost. Never call
   * it from inside itself: the inner call would wait for the outer one forever.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function createContext(deps: CoreDeps): CoreContext {
  const clock = deps.clock ?? { now: () => new Date() };
  let cached: HouseholdSettings | null = null;
  let timeZone = 'Europe/London';
  let queue: Promise<unknown> = Promise.resolve();
  const ctx: CoreContext = {
    storage: deps.storage,
    files: deps.files,
    search: deps.search,
    events: deps.events,
    lookupTimeoutMs: deps.lookupTimeoutMs ?? 4000,
    fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    homeAssistant: deps.homeAssistant ?? null,
    clock,
    now: () => isoNow(clock),
    today: () => localDate(clock.now(), timeZone),
    async household() {
      if (!cached) {
        cached = HouseholdSettings.parse((await deps.storage.settings.get('household')) ?? {});
        timeZone = cached.timeZone;
      }
      return cached;
    },
    publish(type, data) {
      deps.events.publish({ type, at: isoNow(clock), data });
      if (type === 'settings.changed') cached = null;
    },
    exclusive(fn) {
      const run = queue.then(fn);
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return ctx;
}
