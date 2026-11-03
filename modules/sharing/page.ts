/**
 * Making sense of a shared link: tidying the address, reading the page for the
 * product's name, picture and price, and a sensible name when the page can't be had.
 */
import { publicWebAddress } from '@larder/core';

export interface PageFacts {
  /** The product's own name (from the page's product data), if it says. */
  name: string | null;
  /** The page title, which often has the shop's name in it too. */
  title: string | null;
  brand: string | null;
  image: string | null;
  price: number | null;
  currency: string | null;
  /** The shop or site's own name, e.g. "Amazon.co.uk". */
  site: string | null;
  /** The page's own address for itself. */
  canonical: string | null;
}

/** Query parameters that only say where a click came from. */
const TRACKING = /^(utm_\w+|ref|ref_|refid|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|igshid|si|_ga|tag|psc|th|smid|spm|scm)$/i;

/** The first web address in what was shared. */
export function findLink(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    const m = t?.match(/https?:\/\/[^\s<>"']+/i);
    if (m) return m[0].replace(/[),.;!?]+$/, '');
  }
  return null;
}

/** The address without tracking bits, so the same product shared twice is spotted. Amazon's become /dp/<item>. */
export function tidyLink(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hash = '';
  const amazonItem = /(^|\.)amazon\.[a-z.]+$/i.test(url.hostname) && url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (amazonItem) return `${url.protocol}//${url.hostname}/dp/${amazonItem[1]!.toUpperCase()}`;
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.href.replace(/\?$/, '');
}

/** "Amazon.co.uk" from www.amazon.co.uk, "Tesco" from www.tesco.com. */
export function siteName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^(www|m|smile)\./, '');
    const parts = host.split('.');
    const main = parts.length > 2 && parts[parts.length - 2]!.length <= 3 ? parts.slice(-3) : parts.slice(-2);
    const name = main[0]!;
    const capitalised = name.charAt(0).toUpperCase() + name.slice(1);
    return /^(amazon|ebay)$/.test(name) ? [capitalised, ...main.slice(1)].join('.') : capitalised;
  } catch {
    return 'the web';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const clean = (s: string | null | undefined) => (s ? decode(s).replace(/\s+/g, ' ').trim() || null : null);

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

/** The product in a page's JSON-LD, if it has one. */
function productData(html: string): Record<string, unknown> | null {
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const queue: unknown[] = [data];
    while (queue.length) {
      const x = queue.shift();
      if (Array.isArray(x)) queue.push(...x);
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const type = o['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return o;
        if (o['@graph']) queue.push(o['@graph']);
      }
    }
  }
  return null;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : null);
const firstImage = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (v && typeof v === 'object') return typeof (v as { url?: unknown }).url === 'string' ? (v as { url: string }).url : null;
  return null;
};

/** What a product page says about itself: its product data first, then its share tags, then its title. */
export function readPage(html: string, address: string): PageFacts {
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop)?.toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  let canonical: string | null = null;
  for (const m of html.matchAll(/<link\s[^>]*>/gi)) {
    const a = attributes(m[0]);
    if (a.rel?.toLowerCase() === 'canonical' && a.href) canonical = a.href;
  }
  const product = productData(html);
  const offers = product?.offers;
  const offer = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;
  const priceText = offer?.price ?? offer?.lowPrice ?? meta['product:price:amount'] ?? meta['og:price:amount'];
  const price = priceText === undefined || priceText === null || priceText === '' ? null : Number(String(priceText).replace(/[^0-9.]/g, ''));
  const resolve = (u: string | null) => {
    if (!u) return null;
    try {
      return new URL(decode(u), address).href;
    } catch {
      return null;
    }
  };
  return {
    name: clean(text(product?.name)),
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    brand: clean(text(product?.brand)),
    image: resolve(firstImage(product?.image) ?? meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? null),
    price: price !== null && Number.isFinite(price) && price > 0 ? price : null,
    currency: clean(String(offer?.priceCurrency ?? meta['product:price:currency'] ?? meta['og:price:currency'] ?? '')) ?? null,
    site: clean(meta['og:site_name']),
    canonical: resolve(canonical ?? meta['og:url'] ?? null),
  };
}

/**
 * A name for the wish list from a page title or what was shared: without the
 * shop's name ("… : Amazon.co.uk: Grocery"), "Check out …" and the link, and
 * cut down when a title runs on ("Anker charger, 20W, fast, …").
 */
export function tidyName(raw: string | null | undefined, site: string): string | null {
  if (!raw) return null;
  let s = raw.replace(/https?:\/\/\S+/g, ' ').split(/\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
  s = s.replace(/^(check (this|it) out|check out|look at|i found|found|have a look at|see)\b[^:]*:\s*/i, '');
  const shop = site.toLowerCase().split('.')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Drop the parts that are just the shop's name ("Amazon.co.uk", "Tesco Groceries"); keep "Tesco Finest Pork Sausages".
  const parts = s.split(/\s+[|–—-]\s+|\s*:\s+/).map((p) => p.trim()).filter(Boolean);
  const isShop = (p: string) => p.toLowerCase().includes(shop) && p.toLowerCase().replace(new RegExp(`${shop}(\\.[a-z.]+)?`, 'g'), ' ').split(/\s+/).filter(Boolean).length <= 2;
  const kept = parts.filter((p) => !isShop(p));
  s = (kept.length ? kept : parts).slice(0, kept.length && kept.length < parts.length ? 1 : parts.length).join(' - ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 80) {
    const cut = s.indexOf(', ', 20);
    s = cut > 0 && cut < 100 ? s.slice(0, cut) : s;
  }
  if (s.length > 120) s = `${s.slice(0, 117).replace(/\s+\S*$/, '')}…`;
  return s || null;
}

/**
 * Fetches a page that's on the public web, following redirects only to the
 * public web too. `url` is where the redirects led (a short link's real
 * address), even when the page itself can't be read; null if it isn't public.
 */
export async function fetchPage(doFetch: typeof fetch, address: string): Promise<{ html: string | null; url: string } | null> {
  let at = publicWebAddress(address);
  let reached: string | null = at?.href ?? null;
  for (let hop = 0; at && hop < 5; hop++) {
    const res = await doFetch(at.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-GB,en;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; Larder home inventory; +https://github.com/doonetheprune/home-inventory)' },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      at = next ? publicWebAddress(new URL(next, at).href) : null;
      // Somewhere not public: keep the last public address, and don't go there.
      if (at) reached = at.href;
      continue;
    }
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) return { html: null, url: at.href };
    // A product page's head is enough; some pages are megabytes.
    const reader = res.body?.getReader();
    if (!reader) return { html: null, url: at.href };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > 1_500_000) {
        await reader.cancel();
        break;
      }
    }
    const all = new Uint8Array(size);
    let pos = 0;
    for (const c of chunks) {
      all.set(c.subarray(0, Math.min(c.byteLength, size - pos)), pos);
      pos += c.byteLength;
    }
    return { html: new TextDecoder().decode(all), url: at.href };
  }
  return reached ? { html: null, url: reached } : null;
}
