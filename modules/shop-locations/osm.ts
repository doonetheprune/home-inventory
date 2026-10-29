/**
 * OpenStreetMap lookups: a shop's branches near home (Overpass, or Nominatim
 * and Photon when Overpass is busy) and a postcode or town to a point on the
 * map (Nominatim). All are free and need no key.
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

/**
 * Public Overpass servers, asked in turn: the main one is often too busy to
 * answer (502, 504, 429). From the OpenStreetMap wiki's list of instances.
 */
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const PHOTON_URL = 'https://photon.komoot.io/api/';
// The services ask callers to say who they are.
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
  const { latitude: lat, longitude: lon } = rounded(home);
  const around = `(around:${Math.round(within + 1000)},${lat},${lon})`;
  const pattern = JSON.stringify(namePattern(shopName));
  return [
    '[out:json][timeout:20];',
    '(',
    ...['name', 'brand'].flatMap((key) => [`  nwr["shop"]["${key}"~${pattern},i]${around};`, `  nwr["amenity"="pharmacy"]["${key}"~${pattern},i]${around};`]),
    ');',
    // Overpass sends these in id order, not by distance, so ask for plenty and keep the nearest.
    'out center tags 400;',
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

/** A branch as a map service describes it, before distances. */
interface Candidate extends Point {
  osmId: string;
  name: string;
  street: string;
  address: string;
}

/** Home rounded to about 1 km: all that leaves the house. */
export function rounded(home: Point): Point {
  return { latitude: Math.round(home.latitude * 100) / 100, longitude: Math.round(home.longitude * 100) / 100 };
}

/** A box reaching `within` metres (plus the rounding) each way from the rounded home. */
function box(home: Point, within: number) {
  const c = rounded(home);
  const dLat = (within + 1000) / 111_320;
  const dLon = (within + 1000) / (111_320 * Math.cos((c.latitude * Math.PI) / 180));
  const f = (n: number) => n.toFixed(4);
  return { west: f(c.longitude - dLon), south: f(c.latitude - dLat), east: f(c.longitude + dLon), north: f(c.latitude + dLat) };
}

/** Nearest first, within `within` metres of the real home, each branch once. */
function nearest(candidates: Candidate[], home: Point, within: number): FoundBranch[] {
  const seen = new Set<string>();
  const out: FoundBranch[] = [];
  for (const c of candidates) {
    if (seen.has(c.osmId)) continue;
    seen.add(c.osmId);
    const metres = distance(home, c);
    if (metres <= within) out.push({ ...c, distance: Math.round(metres) });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, 40);
}

/** Turns Overpass's answer into branches, nearest first, keeping those within `within` metres of the real home. */
export function branchesFrom(elements: OsmElement[], shopName: string, home: Point, within: number): FoundBranch[] {
  const candidates = elements.flatMap((e): Candidate[] => {
    const at = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
    const tags = e.tags ?? {};
    if (!at || tags.shop === 'vacant' || tags.disused === 'yes') return [];
    return [{ osmId: `${e.type}/${e.id}`, name: tags.name ?? tags.brand ?? shopName, street: tags['addr:street'] ?? '', address: addressOf(tags), latitude: at.lat, longitude: at.lon }];
  });
  return nearest(candidates, home, within);
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** Overpass explains a rejected query in an HTML page; keep its words. */
const plainText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Why one server couldn't help, for the message when none could. */
class Problem extends Error {}

/** Fetches JSON, turning every way a server can fail into a Problem that names it. */
async function askFor<T>(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { ...init, headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Problem(`${host(url)} didn't answer${err instanceof Error && err.name === 'TimeoutError' ? ' in time' : ''}`);
  }
  if (res.status === 400) throw new Problem(`${host(url)} didn't understand the search: ${plainText(await res.text()).slice(0, 200)}`);
  if (!res.ok) throw new Problem(`${host(url)} answered ${res.status}`);
  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw new Problem(`${host(url)} sent a page instead of map data`);
  }
}

async function fromOverpass(f: typeof fetch, url: string, shopName: string, home: Point, within: number, timeoutMs: number): Promise<FoundBranch[]> {
  const answer = await askFor<{ elements?: OsmElement[]; remark?: string }>(f, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: overpassQuery(shopName, home, within) }).toString(),
  }, timeoutMs);
  // A busy server can answer 200 with no results and a remark such as "runtime error: Query timed out".
  if (!answer.elements?.length && answer.remark && /error|timed out|out of memory/i.test(answer.remark)) throw new Problem(`${host(url)}: ${answer.remark.slice(0, 120)}`);
  return branchesFrom(answer.elements ?? [], shopName, home, within);
}

/** Nominatim's search, for shops named like this one inside the box. At most 40, by importance rather than distance. */
async function fromNominatim(f: typeof fetch, url: string, shopName: string, home: Point, within: number, timeoutMs: number): Promise<FoundBranch[]> {
  const b = box(home, within);
  const q = new URLSearchParams({ q: shopName, format: 'jsonv2', limit: '40', viewbox: `${b.west},${b.north},${b.east},${b.south}`, bounded: '1', addressdetails: '1', layer: 'poi' });
  const hits = await askFor<Array<{ osm_type: string; osm_id: number; lat: string; lon: string; name?: string; category?: string; type?: string; address?: Record<string, string> }>>(f, `${url}?${q}`, {}, timeoutMs);
  const named = new RegExp(namePattern(shopName), 'i');
  return nearest(hits.flatMap((h): Candidate[] => {
    if (!(h.category === 'shop' || (h.category === 'amenity' && h.type === 'pharmacy')) || !h.name || !named.test(h.name)) return [];
    const a = h.address ?? {};
    const address = [[a.house_number, a.road].filter(Boolean).join(' '), a.suburb ?? a.city ?? a.town ?? a.village, a.postcode].filter(Boolean).join(', ');
    return [{ osmId: `${h.osm_type}/${h.osm_id}`, name: h.name, street: a.road ?? '', address, latitude: Number(h.lat), longitude: Number(h.lon) }];
  }), home, within);
}

/** Komoot's Photon search (OpenStreetMap data too), limited to shops inside the box. */
async function fromPhoton(f: typeof fetch, url: string, shopName: string, home: Point, within: number, timeoutMs: number): Promise<FoundBranch[]> {
  const b = box(home, within);
  const q = new URLSearchParams({ q: shopName, limit: '50', lang: 'en', bbox: `${b.west},${b.south},${b.east},${b.north}`, osm_tag: 'shop' });
  const answer = await askFor<{ features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: Record<string, string | number> }> }>(f, `${url}?${q}`, {}, timeoutMs);
  const named = new RegExp(namePattern(shopName), 'i');
  const types: Record<string, string> = { N: 'node', W: 'way', R: 'relation' };
  return nearest((answer.features ?? []).flatMap((ft): Candidate[] => {
    const p = ft.properties ?? {};
    const [lon, lat] = ft.geometry?.coordinates ?? [];
    const name = typeof p.name === 'string' ? p.name : '';
    if (lat === undefined || lon === undefined || !name || !named.test(name) || !types[String(p.osm_type)]) return [];
    const street = typeof p.street === 'string' ? p.street : '';
    const address = [[p.housenumber, street].filter(Boolean).join(' '), p.district ?? p.locality ?? p.city, p.postcode].filter(Boolean).join(', ');
    return [{ osmId: `${types[String(p.osm_type)]}/${p.osm_id}`, name, street, address, latitude: lat, longitude: lon }];
  }), home, within);
}

export interface MapServers {
  overpass: string[];
  nominatim: string;
  photon: string;
}
export const MAP_SERVERS: MapServers = { overpass: OVERPASS_URLS, nominatim: NOMINATIM_URL, photon: PHOTON_URL };

/**
 * Branches near home: each Overpass server in turn, then Nominatim, then
 * Photon. Throws, naming what each said, only when none could answer.
 */
export async function findBranches(f: typeof fetch, shopName: string, home: Point, within: number, servers: MapServers = MAP_SERVERS, timeoutMs = 25_000): Promise<FoundBranch[]> {
  const problems: string[] = [];
  const tries: Array<() => Promise<FoundBranch[]>> = [
    ...servers.overpass.map((url) => () => fromOverpass(f, url, shopName, home, within, timeoutMs)),
    () => fromNominatim(f, servers.nominatim, shopName, home, within, timeoutMs),
    () => fromPhoton(f, servers.photon, shopName, home, within, timeoutMs),
  ];
  let overpassRejected = false;
  for (const [i, attempt] of tries.entries()) {
    // A search one Overpass server can't read, none can: go straight on to the others.
    if (overpassRejected && i < servers.overpass.length) continue;
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof Problem)) throw err;
      problems.push(err.message);
      if (i < servers.overpass.length && err.message.includes("didn't understand")) overpassRejected = true;
    }
  }
  throw new Error(`OpenStreetMap's map servers are busy (${problems.join('; ')}).`);
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
