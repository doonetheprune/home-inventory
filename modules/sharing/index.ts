/**
 * Sharing: a link shared to the Home Assistant app on a phone (the Android
 * share menu, then Home Assistant) is sent here by the Larder integration and
 * waits in Pending, named from the page, with its picture and price. From
 * Pending it goes on the wish list, or into Larder as something already got
 * (through the Add item page); either way the item keeps the link and where it
 * came from.
 */
import { z } from 'zod';
import { defineModule, LarderError, newId } from '@larder/core';
import { fetchPage, findLink, readPage, siteName, tidyLink, tidyName, type PageFacts } from './page';

/** Where an item came from, kept on it once it leaves Pending (`product.fields.sharing`). */
export const SharedFrom = z.object({
  url: z.string().max(2000),
  site: z.string().max(80),
  /** The app it was shared from, as Android names it, e.g. "com.amazon.mShop.android.shopping". */
  app: z.string().max(200).nullable().default(null),
  /** The phone it was shared from. */
  device: z.string().max(200).nullable().default(null),
  sharedAt: z.string(),
  price: z.number().nullable().default(null),
  currency: z.string().max(3).nullable().default(null),
});
export type SharedFrom = z.infer<typeof SharedFrom>;

/** A shared link waiting in Pending: not an item yet. */
export const PendingShare = SharedFrom.extend({
  id: z.string(),
  name: z.string(),
  /** The page's picture, saved as a Larder photo. */
  photoFileId: z.string().nullable(),
});
export type PendingShare = z.infer<typeof PendingShare>;

const Shared = z.object({
  /** The link, when the app shared one on its own. */
  url: z.string().max(4000).nullable().optional(),
  /** What was shared as text: often a title with the link in it. */
  text: z.string().max(4000).nullable().optional(),
  subject: z.string().max(1000).nullable().optional(),
  app: z.string().max(200).nullable().optional(),
  device: z.string().max(200).nullable().optional(),
});

const Answer = z.object({
  /** pending: waiting in Pending. exists: already in Pending or in Larder, nothing changed. */
  status: z.enum(['pending', 'exists']),
  /** A sentence for a notification. */
  message: z.string(),
  name: z.string(),
  /** The Pending entry, when that's where it is. */
  pendingId: z.string().nullable(),
  /** The item, when Larder already has it. */
  productId: z.string().nullable(),
  /** Where to open it inside Home Assistant (for a notification's tap), when Larder knows. */
  appLink: z.string().nullable(),
});

const money = (price: number, currency: string | null) => {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(price);
  } catch {
    return `${price.toFixed(2)} ${currency ?? ''}`.trim();
  }
};

export default defineModule({
  id: 'sharing',
  name: 'Sharing',
  description: 'Links you share to the Home Assistant app on your phone wait in Pending, named from the page with its photo and price, to go on the wish list or into Larder.',
  version: '1.0.0',
  defaultEnabled: true,
  productFields: SharedFrom,
  setup(ctx) {
    const pending = ctx.collection<PendingShare>('pending');

    async function appLink(where: string): Promise<string | null> {
      const path = ctx.core.homeAssistant ? await ctx.core.homeAssistant.appPath().catch(() => null) : null;
      return path ? `${path}#${where}` : null;
    }
    async function allPending(): Promise<PendingShare[]> {
      return (await pending.list()).map((x) => x.data).sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
    }
    async function onePending(id: string): Promise<PendingShare> {
      const p = await pending.get(id);
      if (!p) throw new LarderError('That shared link isn\'t in Pending any more.', 404, 'not_found');
      return p;
    }
    const from = (p: PendingShare): SharedFrom => SharedFrom.parse({ url: p.url, site: p.site, app: p.app, device: p.device, sharedAt: p.sharedAt, price: p.price, currency: p.currency });
    const priceNote = (p: PendingShare) => (p.price !== null ? `${money(p.price, p.currency)} at ${p.site} when it was shared (${p.sharedAt.slice(0, 10)}).` : '');

    ctx.addRoute({
      method: 'POST',
      path: '/link',
      summary: 'Put a shared link in Pending (from the Home Assistant app\'s share menu)',
      description: 'Send what the phone shared: the link, or text with a link in it. Larder reads the page for the product\'s name, picture and price, and puts it in Pending, to go on the wish list or into Larder. Something already in Pending or in Larder (the same link, or the same name) isn\'t added again.',
      body: Shared,
      response: Answer,
      async handler({ body }) {
        const found = findLink(body.url, body.text, body.subject);
        if (!found) throw new LarderError('There\'s no link in what was shared. Share a web page to send it to Larder.', 400, 'invalid');
        const link = tidyLink(found);

        const waiting = await allPending();
        // Every item, wish list included ("all" means everything owned).
        const items = [...(await ctx.core.products.list({ status: 'all' })), ...(await ctx.core.products.list({ status: 'wish' }))];
        let links = [link];
        const same = (u: string) => links.includes(tidyLink(u));
        const known = (byName?: string) => {
          const p = waiting.find((w) => same(w.url) || (byName !== undefined && w.name.toLowerCase() === byName));
          if (p) return exists({ pendingId: p.id, name: p.name, message: `${p.name} is already in Pending.` });
          const s = items.find((x) => x.product.links.some((l) => same(l.url)) || (x.product.fields.sharing && same((x.product.fields.sharing as SharedFrom).url)) || (byName !== undefined && x.product.name.toLowerCase() === byName));
          if (s) return exists({ productId: s.product.id, name: s.product.name, message: s.product.wish ? `${s.product.name} is already on the wish list.` : `${s.product.name} is already in Larder.` });
          return null;
        };
        const before = known();
        if (before) return before;

        // Read the page for its name, picture and price. Shops sometimes turn robots away: then the shared text names it.
        let page: PageFacts | null = null;
        let pageUrl = link;
        try {
          const got = await fetchPage(ctx.fetch, link);
          if (got) {
            pageUrl = got.url;
            if (got.html) page = readPage(got.html, got.url);
          }
        } catch (err) {
          ctx.log.info('Couldn\'t read a shared page', { link, error: err instanceof Error ? err.message : String(err) });
        }
        const finalLink = tidyLink(page?.canonical ?? pageUrl);
        const site = page?.site ?? siteName(finalLink);
        const name = tidyName(page?.name, site) ?? tidyName(page?.title, site) ?? tidyName(body.subject, site) ?? tidyName(body.text, site) ?? `Something from ${site}`;
        // A short link only shows where it goes once followed: check again with the real address and the name.
        links = [...new Set([link, tidyLink(pageUrl), finalLink])];
        const named = known(name.toLowerCase());
        if (named) return named;

        const entry: PendingShare = PendingShare.parse({
          id: newId(),
          name,
          url: finalLink,
          site,
          app: body.app ?? null,
          device: body.device ?? null,
          sharedAt: ctx.core.now(),
          price: page?.price ?? null,
          currency: page?.currency?.slice(0, 3) ?? null,
          photoFileId: page?.image ? await ctx.core.lookup.savePhotoFromLink(page.image, name) : null,
        });
        await pending.put(entry.id, entry);
        ctx.publish('sharing.pending', { id: entry.id, name, url: finalLink, site });
        return { status: 'pending' as const, message: `Added ${name} to Pending.`, name, pendingId: entry.id, productId: null, appLink: await appLink('/m/sharing/') };
      },
    });

    async function exists(x: { pendingId?: string; productId?: string; name: string; message: string }) {
      return {
        status: 'exists' as const,
        message: x.message,
        name: x.name,
        pendingId: x.pendingId ?? null,
        productId: x.productId ?? null,
        appLink: await appLink(x.productId ? `/products/${x.productId}` : '/m/sharing/'),
      };
    }

    ctx.addRoute({
      method: 'GET',
      path: '/pending',
      summary: 'Shared links waiting in Pending, newest first',
      response: z.array(PendingShare),
      handler: () => allPending(),
    });

    ctx.addRoute({
      method: 'POST',
      path: '/pending/:id/wish',
      summary: 'Put a shared link from Pending on the wish list',
      params: z.object({ id: z.string() }),
      response: z.object({ productId: z.string(), name: z.string() }),
      async handler({ params }) {
        const p = await onePending(params.id);
        const product = await ctx.core.products.create({
          name: p.name,
          wish: true,
          links: [{ url: p.url, title: p.site }],
          photoFileIds: p.photoFileId ? [p.photoFileId] : [],
          notes: priceNote(p),
          fields: { sharing: from(p) },
        });
        await pending.remove(p.id);
        ctx.publish('sharing.decided', { id: p.id, productId: product.id, to: 'wish' });
        return { productId: product.id, name: product.name };
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/pending/:id/added',
      summary: 'A shared link from Pending was added to Larder (through the Add item page): it leaves Pending, and the item keeps where it came from',
      params: z.object({ id: z.string() }),
      body: z.object({ productId: z.string() }),
      response: z.object({ productId: z.string() }),
      async handler({ params, body }) {
        const p = await onePending(params.id);
        await ctx.core.products.updateField<SharedFrom>(body.productId, 'sharing', () => from(p));
        await pending.remove(p.id);
        ctx.publish('sharing.decided', { id: p.id, productId: body.productId, to: 'larder' });
        return { productId: body.productId };
      },
    });

    ctx.addRoute({
      method: 'DELETE',
      path: '/pending/:id',
      summary: 'Forget a shared link in Pending (shared by mistake), and its picture',
      params: z.object({ id: z.string() }),
      response: z.object({ removed: z.boolean() }),
      async handler({ params }) {
        const p = await onePending(params.id);
        await pending.remove(p.id);
        // Its picture was only kept for Pending; nothing else uses it (forgetPhoto checks).
        if (p.photoFileId) await ctx.core.lookup.forgetPhoto(p.photoFileId);
        return { removed: true };
      },
    });
  },
});
