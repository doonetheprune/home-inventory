/**
 * OpenStreetMap lookups: a shop's branches near home (Overpass) and a postcode
 * or town to a point on the map (Nominatim). Both are free and need no key.
 *
 * Home's position is rounded to about 1 km before it leaves the house, and the
 * search widened by as much; exact distances are worked out here.
 */

export interface Point {
  latitude: number;
  longitude: number;
}

export interface FoundBranch extends Point {
  /** "node/123", "way/456": the same branch keeps its id in OpenStreetMap. */
  osmId: string;
  name: string;
  /** For telling branches apart: "Wilmslow Road". */
  street: string;
  address: string;
  /** Metres from home. */
  distance: number;
}

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Both services ask callers to say who they are.
const USER_AGENT = 'Larder home inventory (self-hosted; shop locations)';

/** Other names OpenStreetMap uses for some UK chains. */
const ALIASES: Record<string, string[]> = {
  'm&s': ['Marks & Spencer', 'Marks and Spencer'],
  'marks & spencer': ['M&S'],
  'b&m': ['B&M Bargains', 'B & M'],
  iceland: ['The Food Warehouse'],
};

/** Metres between two points. */
export function distance(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * A pattern that matches a shop's name as it's written on the map: any case,
 * with or without its apostrophe ("Sainsburys"), "&" or "and", and at the
 * start of a word, so "Aldi" doesn't match "Waldis".
 */
export function namePattern(name: string): string {
  const one = (n: string) =>
    [...n.trim().toLowerCase()]
      .map((c) => {
        if (/[a-z0-9]/.test(c)) return c;
        // An alternation, not [brackets]: Overpass matches bytes, and ’ is three of them.
        if (c === "'" || c === '’') return "('|’)?";
        if (c === '&') return '( ?& ?| and )';
        if (c === ' ' || c === '-') return '[ -]?';
        return '.?';
      })
      .join('');
  const names = [name, ...(ALIASES[name.trim().toLowerCase()] ?? [])];
  return `(^|[^a-z])(${names.map(one).join('|')})`;
}

/** Overpass QL for shops (and pharmacies) whose name or brand matches, within `within` metres. */
export function overpassQuery(shopName: string, home: Point, within: number): string {
  // About 1 km of rounding; the search reaches that much further so nothing near the real home is missed.
  const lat = Math.round(home.latitude * 100) / 100;
  const lon = Math.round(home.longitude * 100) / 100;
  const around = `(around:${Math.round(within + 1000)},${lat},${lon})`;
  const pattern = JSON.stringify(namePattern(shopName));
  return [
    '[out:json][timeout:20];',
    '(',
    ...['name', 'brand'].flatMap((key) => [`  nwr["shop"]["${key}"~${pattern},i]${around};`, `  nwr["amenity"="pharmacy"]["${key}"~${pattern},i]${around};`]),
    ');',
    'out center tags 80;',
  ].join('\n');
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** "12 Wilmslow Road, Rusholme, M14 5TQ". */
export function addressOf(tags: Record<string, string>): string {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const area = tags['addr:suburb'] ?? tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'] ?? tags['addr:place'];
  return [street, area, tags['addr:postcode']].filter(Boolean).join(', ');
}

/** Turns Overpass's answer into branches, nearest first, keeping those within `within` metres of the real home. */
export function branchesFrom(elements: OsmElement[], shopName: string, home: Point, within: number): FoundBranch[] {
  const seen = new Set<string>();
  const out: FoundBranch[] = [];
  for (const e of elements) {
    const at = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
    const tags = e.tags ?? {};
    const osmId = `${e.type}/${e.id}`;
    if (!at || seen.has(osmId) || tags.shop === 'vacant' || tags.disused === 'yes') continue;
    seen.add(osmId);
    const point = { latitude: at.lat, longitude: at.lon };
    const metres = distance(home, point);
    if (metres > within) continue;
    out.push({ osmId, name: tags.name ?? tags.brand ?? shopName, street: tags['addr:street'] ?? '', address: addressOf(tags), ...point, distance: Math.round(metres) });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, 25);
}

export async function findBranches(f: typeof fetch, shopName: string, home: Point, within: number, url = OVERPASS_URL): Promise<FoundBranch[]> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ data: overpassQuery(shopName, home, within) }).toString(),
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 429 || res.status === 504) throw new Error('The map service is busy. Try again in a minute.');
  if (!res.ok) throw new Error(`The map service answered ${res.status}.`);
  const body = (await res.json()) as { elements?: OsmElement[] };
  return branchesFrom(body.elements ?? [], shopName, home, within);
}

/** A postcode, town or address to a point, or null when the map doesn't know it. */
export async function geocode(f: typeof fetch, query: string, url = NOMINATIM_URL): Promise<(Point & { label: string }) | null> {
  const q = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1' });
  const res = await f(`${url}?${q}`, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`The map service answered ${res.status}.`);
  const [hit] = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!hit) return null;
  return { latitude: Number(hit.lat), longitude: Number(hit.lon), label: hit.display_name.split(', ').slice(0, 3).join(', ') };
}
