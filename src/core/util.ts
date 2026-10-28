/** Small helpers shared by core services. No I/O. */

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function isoNow(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

/** Today's date in the household's local time zone as YYYY-MM-DD. */
export function localDate(d: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Avoids floating point noise like 0.30000000000000004. */
export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function byName<T extends { name: string; sortOrder?: number }>(a: T, b: T): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'en-GB');
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
