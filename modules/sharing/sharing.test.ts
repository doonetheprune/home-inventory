import { describe, expect, it } from 'vitest';
import type { HomeAssistantPort } from '@larder/core';
import { makeCore } from '../../tests/helpers';
import sharing, { type PendingShare, type SharedFrom } from './index';
import { findLink, readPage, siteName, tidyLink, tidyName } from './page';

type Core = Awaited<ReturnType<typeof makeCore>>;
interface Answer { status: string; message: string; name: string; pendingId: string | null; productId: string | null; appLink: string | null }
const route = (core: Core, method: string, path: string) => core.modules.routes().find((r) => r.moduleId === 'sharing' && r.route.method === method && r.route.path === path)!.route;
const share = (core: Core, body: unknown) => route(core, 'POST', '/link').handler({ body, query: {}, params: {}, userId: null }) as Promise<Answer>;
const waiting = (core: Core) => route(core, 'GET', '/pending').handler({ body: undefined, query: {}, params: {}, userId: null }) as Promise<PendingShare[]>;
const decide = <T,>(core: Core, method: string, path: string, id: string, body?: unknown) => route(core, method, path).handler({ body, query: {}, params: { id }, userId: null }) as Promise<T>;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(1)]);

const TESCO_PAGE = `<!doctype html><html><head>
<title>Tesco Finest Pork Sausages 400G - Tesco Groceries</title>
<meta property="og:site_name" content="Tesco">
<meta content="Tesco Finest 6 Pork Sausages 400G" property="og:title">
<link rel="canonical" href="https://www.tesco.com/groceries/en-GB/products/254656543">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Tesco Finest 6 Pork Sausages 400G","brand":{"@type":"Brand","name":"Tesco Finest"},"image":["/img/sausages.jpg"],"offers":{"@type":"Offer","price":"3.50","priceCurrency":"GBP"}}]}</script>
</head><body>…</body></html>`;

/** A pretend internet. Records every address asked for. */
function internet() {
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const u = new URL(url);
    if (u.hostname === 'www.tesco.com' && u.pathname.startsWith('/groceries/')) return new Response(TESCO_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (u.hostname === 'www.tesco.com' && u.pathname === '/img/sausages.jpg') return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    if (u.hostname === 'amzn.eu') return new Response(null, { status: 301, headers: { location: 'https://www.amazon.co.uk/Oatly-Barista/dp/b07xyz1234/ref=sr_1_3?keywords=oat&th=1' } });
    if (u.hostname === 'www.amazon.co.uk') return new Response('<html>Robot check</html>', { status: 503, headers: { 'content-type': 'text/html' } });
    if (u.hostname === 'short.example.com') return new Response(null, { status: 302, headers: { location: 'https://router.lan/admin' } });
    throw new Error(`No network in tests (${url})`);
  }) as unknown as typeof fetch;
  return { fetch: fake, asked };
}

describe('Sharing: a shared link waits in Pending', () => {
  it('names it from the page, with its picture and price, and isn\'t an item yet', async () => {
    const net = internet();
    const core = await makeCore({ modules: [sharing], fetch: net.fetch, homeAssistant: { appPath: async () => '/a0d7b954_larder' } as unknown as HomeAssistantPort });
    const out = await share(core, {
      url: 'https://www.tesco.com/groceries/en-GB/products/254656543?utm_source=app&utm_medium=share',
      text: null,
      subject: 'Tesco Finest 6 Pork Sausages 400G',
      app: 'com.tesco.grocery.view',
      device: 'Shaun’s Pixel',
    });
    expect(out).toMatchObject({ status: 'pending', message: 'Added Tesco Finest 6 Pork Sausages 400G to Pending.', name: 'Tesco Finest 6 Pork Sausages 400G', productId: null, appLink: '/a0d7b954_larder#/m/sharing/' });

    const [p] = await waiting(core);
    expect(p).toMatchObject({
      id: out.pendingId, name: 'Tesco Finest 6 Pork Sausages 400G', url: 'https://www.tesco.com/groceries/en-GB/products/254656543', site: 'Tesco',
      app: 'com.tesco.grocery.view', device: 'Shaun’s Pixel', sharedAt: '2026-10-28T09:00:00.000Z', price: 3.5, currency: 'GBP',
    });
    expect(p!.photoFileId).toBeTruthy();
    // Not on the wish list, not in stock: nothing counts it until someone decides.
    expect(await core.products.list({ status: 'wish' })).toEqual([]);
    expect(await core.products.list({ status: 'all' })).toEqual([]);
    expect(core.events.log.find((e) => e.type === 'sharing.pending')?.data).toMatchObject({ id: out.pendingId, site: 'Tesco' });
    expect(net.asked).toEqual(['https://www.tesco.com/groceries/en-GB/products/254656543', 'https://www.tesco.com/img/sausages.jpg']);
  });

  it('goes on the wish list from Pending, keeping the link, photo, price and where it came from', async () => {
    const core = await makeCore({ modules: [sharing], fetch: internet().fetch });
    const out = await share(core, { url: 'https://www.tesco.com/groceries/en-GB/products/254656543', device: 'Shaun’s Pixel' });
    const photo = (await waiting(core))[0]!.photoFileId;
    const made = await decide<{ productId: string }>(core, 'POST', '/pending/:id/wish', out.pendingId!);
    const p = (await core.products.get(made.productId)).product;
    expect(p).toMatchObject({ name: 'Tesco Finest 6 Pork Sausages 400G', wish: true, photoFileIds: [photo], notes: '£3.50 at Tesco when it was shared (2026-10-28).' });
    expect(p.links).toEqual([{ url: 'https://www.tesco.com/groceries/en-GB/products/254656543', title: 'Tesco' }]);
    expect(p.fields.sharing).toEqual({
      url: 'https://www.tesco.com/groceries/en-GB/products/254656543', site: 'Tesco', app: null, device: 'Shaun’s Pixel', sharedAt: '2026-10-28T09:00:00.000Z', price: 3.5, currency: 'GBP',
    } satisfies SharedFrom);
    expect(await waiting(core)).toEqual([]);
    // The picture is the item's now, so it stays.
    expect(await core.adapters.files.get(photo!)).not.toBeNull();
    await expect(decide(core, 'POST', '/pending/:id/wish', out.pendingId!)).rejects.toMatchObject({ status: 404 });
  });

  it('goes into Larder from Pending through the Add item page, and the item keeps where it came from', async () => {
    const core = await makeCore({ modules: [sharing], fetch: internet().fetch });
    const out = await share(core, { text: 'Check out this deal on Amazon: Oatly Barista Edition Oat Drink 1L https://amzn.eu/d/abc', app: 'com.amazon.mShop.android.shopping' });
    // The Add item page makes the item; then Pending is told.
    const made = await core.products.create({ name: 'Oat drink', unit: 'carton', links: [{ url: 'https://www.amazon.co.uk/dp/B07XYZ1234', title: 'Amazon.co.uk' }] });
    await decide(core, 'POST', '/pending/:id/added', out.pendingId!, { productId: made.id });
    expect((await core.products.get(made.id)).product.fields.sharing).toMatchObject({ url: 'https://www.amazon.co.uk/dp/B07XYZ1234', site: 'Amazon.co.uk', app: 'com.amazon.mShop.android.shopping' });
    expect(await waiting(core)).toEqual([]);
    // Shared again, it's in Larder already.
    expect(await share(core, { text: 'https://amzn.eu/d/abc' })).toMatchObject({ status: 'exists', productId: made.id, message: 'Oat drink is already in Larder.' });
  });

  it('can be forgotten when it was shared by mistake, picture and all', async () => {
    const core = await makeCore({ modules: [sharing], fetch: internet().fetch });
    const out = await share(core, { url: 'https://www.tesco.com/groceries/en-GB/products/254656543' });
    const photo = (await waiting(core))[0]!.photoFileId!;
    expect(await core.adapters.files.get(photo)).not.toBeNull();
    await decide(core, 'DELETE', '/pending/:id', out.pendingId!);
    expect(await waiting(core)).toEqual([]);
    expect(await core.products.list({ status: 'wish' })).toEqual([]);
    expect(await core.adapters.files.get(photo)).toBeNull();
  });

  it('doesn\'t add the same thing twice', async () => {
    const core = await makeCore({ modules: [sharing], fetch: internet().fetch });
    const first = await share(core, { url: 'https://www.tesco.com/groceries/en-GB/products/254656543?utm_source=app' });
    const again = await share(core, { text: 'Look at this https://www.tesco.com/groceries/en-GB/products/254656543?utm_campaign=x' });
    expect(again).toMatchObject({ status: 'exists', pendingId: first.pendingId, message: 'Tesco Finest 6 Pork Sausages 400G is already in Pending.' });
    expect(await waiting(core)).toHaveLength(1);
    await decide(core, 'POST', '/pending/:id/wish', first.pendingId!);
    expect(await share(core, { url: 'https://www.tesco.com/groceries/en-GB/products/254656543' })).toMatchObject({ status: 'exists', message: 'Tesco Finest 6 Pork Sausages 400G is already on the wish list.' });

    // Something already owned under that name says so.
    const owned = await core.products.create({ name: 'Oatly Barista Edition Oat Drink 1L' });
    const r = await share(core, { text: 'Check out this deal on Amazon: Oatly Barista Edition Oat Drink 1L https://amzn.eu/d/abc' });
    expect(r).toMatchObject({ status: 'exists', productId: owned.id, message: 'Oatly Barista Edition Oat Drink 1L is already in Larder.' });
  });

  it('names it from what was shared when the shop turns robots away, and tidies the address', async () => {
    const net = internet();
    const core = await makeCore({ modules: [sharing], fetch: net.fetch });
    const out = await share(core, { text: 'Check out this deal on Amazon: Oatly Barista Edition Oat Drink 1L https://amzn.eu/d/abc', app: 'com.amazon.mShop.android.shopping' });
    expect(out).toMatchObject({ status: 'pending', name: 'Oatly Barista Edition Oat Drink 1L', appLink: null });
    expect((await waiting(core))[0]).toMatchObject({ url: 'https://www.amazon.co.uk/dp/B07XYZ1234', site: 'Amazon.co.uk', photoFileId: null, price: null });
    expect(net.asked).toEqual(['https://amzn.eu/d/abc', 'https://www.amazon.co.uk/Oatly-Barista/dp/b07xyz1234/ref=sr_1_3?keywords=oat&th=1']);
  });

  it('never fetches from the home network, even through a redirect', async () => {
    const net = internet();
    const core = await makeCore({ modules: [sharing], fetch: net.fetch });
    const inside = await share(core, { url: 'https://192.168.1.5/admin', subject: 'Router page' });
    expect(inside).toMatchObject({ status: 'pending', name: 'Router page' });
    await share(core, { url: 'http://shop.example.com/thing', subject: 'Not https' });
    await share(core, { url: 'https://homeassistant.local:8123/', subject: 'Home Assistant' });
    const redirected = await share(core, { url: 'https://short.example.com/x' });
    expect(redirected.name).toBe('Something from Example');
    expect(net.asked).toEqual(['https://short.example.com/x']);
  });

  it('says so when nothing shared has a link in it', async () => {
    const core = await makeCore({ modules: [sharing], fetch: internet().fetch });
    await expect(share(core, { text: 'loo roll' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('Sharing: making sense of links and titles', () => {
  it('finds and tidies links', () => {
    expect(findLink(null, 'Have a look: https://example.com/a?b=1).')).toBe('https://example.com/a?b=1');
    expect(findLink('no link here')).toBeNull();
    expect(tidyLink('https://www.amazon.co.uk/Anker-Charger/dp/B0ABCD1234/ref=sr_1?crid=1&th=1#reviews')).toBe('https://www.amazon.co.uk/dp/B0ABCD1234');
    expect(tidyLink('https://www.amazon.co.uk/gp/aw/d/B0ABCD1234?psc=1')).toBe('https://www.amazon.co.uk/dp/B0ABCD1234');
    expect(tidyLink('https://shop.example.com/p/1?colour=red&utm_source=x&fbclid=y')).toBe('https://shop.example.com/p/1?colour=red');
  });

  it('names sites', () => {
    expect(siteName('https://www.amazon.co.uk/dp/X')).toBe('Amazon.co.uk');
    expect(siteName('https://www.tesco.com/x')).toBe('Tesco');
    expect(siteName('https://www.screwfix.com/p/1')).toBe('Screwfix');
    expect(siteName('https://groceries.asda.com/product/1')).toBe('Asda');
  });

  it('turns titles into wish list names', () => {
    expect(tidyName('Amazon.co.uk: Oatly Barista Edition Oat Drink 1L: Grocery', 'Amazon.co.uk')).toBe('Oatly Barista Edition Oat Drink 1L');
    expect(tidyName('Oatly Barista Edition Oat Drink 1L : Amazon.co.uk: Grocery', 'Amazon.co.uk')).toBe('Oatly Barista Edition Oat Drink 1L');
    expect(tidyName('Tesco Finest Pork Sausages 400G - Tesco Groceries', 'Tesco')).toBe('Tesco Finest Pork Sausages 400G');
    expect(tidyName('Anker Nano Charger 20W, USB C Charger, PIQ 3.0 Durable Compact Fast Charger for iPhone 15 and Galaxy', 'Amazon.co.uk')).toBe('Anker Nano Charger 20W');
    expect(tidyName('Check out this product on Amazon: Dog bed\nhttps://amzn.eu/d/x', 'Amazon.co.uk')).toBe('Dog bed');
    expect(tidyName('https://amzn.eu/d/x', 'Amazon.co.uk')).toBeNull();
  });

  it('reads product pages, share tags and plain titles', () => {
    expect(readPage(TESCO_PAGE, 'https://www.tesco.com/groceries/en-GB/products/254656543')).toEqual({
      name: 'Tesco Finest 6 Pork Sausages 400G', title: 'Tesco Finest 6 Pork Sausages 400G', brand: 'Tesco Finest', image: 'https://www.tesco.com/img/sausages.jpg',
      price: 3.5, currency: 'GBP', site: 'Tesco', canonical: 'https://www.tesco.com/groceries/en-GB/products/254656543',
    });
    const plain = readPage('<html><head><title>Fish &amp; Chips &#8211; Shop</title><meta name="twitter:image" content="https://cdn.example.com/f.png"></head></html>', 'https://shop.example.com/f');
    expect(plain).toMatchObject({ name: null, title: 'Fish & Chips – Shop', image: 'https://cdn.example.com/f.png', price: null, site: null });
  });
});
