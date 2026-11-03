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

/** "shelf" → "shelves", "box" → "boxes", "roll" → "rolls". */
export function pluralWord(word: string, n: number): string {
  if (n === 1) return word;
  if (/[^f]f$/i.test(word)) return `${word.slice(0, -1)}ves`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** "Aldi", "Aldi and Tesco", "Aldi, Tesco and Toolstation". */
export function andList(items: string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const MEASURES = new Set(['g', 'kg', 'ml', 'l', 'm', 'cm']);

/** "2 tins", "1 battery", "500 g", "3" (for things counted as "each"). */
export function amount(n: number, unit: string): string {
  const q = roundQty(n);
  if (unit === 'each') return String(q);
  if (MEASURES.has(unit.toLowerCase())) return `${q} ${unit}`;
  return `${q} ${q > 0 && q <= 1 ? unit : pluralWord(unit, q)}`;
}

/**
 * The address, if it's somewhere on the public web Larder may fetch from for
 * someone (a shared link, its picture): https, a real domain name, and not a
 * name or numbered address that points inside the home network. Null otherwise.
 * It can't see where a name points, so it isn't a firewall, but it stops the
 * plain cases (a router's page, a NAS, Home Assistant itself).
 */
export function publicWebAddress(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[')) return null;
  // Numbered addresses: a shop's link has a name.
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  if (/(^|\.)(localhost|local|lan|home|internal|intranet|corp|home\.arpa|localdomain)$/.test(host)) return null;
  return url;
}
