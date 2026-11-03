/**
 * Sharing: a link shared to the Home Assistant app on a phone (the Android
 * share menu, then Home Assistant) is sent here by the Larder integration and
 * goes on the wish list, named from the page, with its picture and price. The
 * item keeps the link and where it came from.
 */
import { z } from 'zod';
import { defineModule, LarderError } from '@larder/core';
import { fetchPage, findLink, readPage, siteName, tidyLink, tidyName, type PageFacts } from './page';

/** What's kept on an item that came from a shared link (`product.fields.sharing`). */
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
  /** Said yes to on the Wish list ("Shared, to check"). Until then it waits there to be checked. */
  confirmed: z.boolean().default(false),
});
export type SharedFrom = z.infer<typeof SharedFrom>;

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
  /** added: a new wish list item. exists: Larder already had it, nothing changed. */
  status: z.enum(['added', 'exists']),
  /** A sentence for a notification. */
  message: z.string(),
  productId: z.string(),
  name: z.string(),
  /** Where the item opens inside Home Assistant (for a notification's tap), when Larder knows. */
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
  description: 'Links you share to the Home Assistant app on your phone go on the wish list, with the page’s name, photo and price.',
  version: '1.0.0',
  defaultEnabled: true,
  productFields: SharedFrom,
  setup(ctx) {
    async function appLink(productId: string): Promise<string | null> {
      const path = ctx.core.homeAssistant ? await ctx.core.homeAssistant.appPath().catch(() => null) : null;
      return path ? `${path}#/products/${productId}` : null;
    }

    ctx.addRoute({
      method: 'POST',
      path: '/link',
      summary: 'Put a shared link on the wish list (from the Home Assistant app\'s share menu)',
      description: 'Send what the phone shared: the link, or text with a link in it. Larder reads the page for the product\'s name, picture and price, and adds it to the wish list, keeping the link. The same link (or an item with the same name) isn\'t added twice.',
      body: Shared,
      response: Answer,
      async handler({ body }) {
        const found = findLink(body.url, body.text, body.subject);
        if (!found) throw new LarderError('There\'s no link in what was shared. Share a web page to put it on the wish list.', 400, 'invalid');
        const link = tidyLink(found);

        // Everything, wish list included ("all" means everything owned).
        const all = [...(await ctx.core.products.list({ status: 'all' })), ...(await ctx.core.products.list({ status: 'wish' }))];
        const same = (u: string) => tidyLink(u) === link;
        const known = all.find((s) => s.product.links.some((l) => same(l.url)) || (s.product.fields.sharing && same((s.product.fields.sharing as SharedFrom).url)));
        if (known) return exists(known.product.id, known.product.name, known.product.wish);

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

        const sameName = all.find((s) => s.product.name.toLowerCase() === name.toLowerCase());
        if (sameName) return exists(sameName.product.id, sameName.product.name, sameName.product.wish);

        const photo = page?.image ? await ctx.core.lookup.savePhotoFromLink(page.image, name) : null;
        const price = page?.price ?? null;
        const sharedAt = ctx.core.now();
        const product = await ctx.core.products.create({
          name,
          wish: true,
          links: [{ url: finalLink, title: site }],
          photoFileIds: photo ? [photo] : [],
          notes: price !== null ? `${money(price, page?.currency ?? null)} at ${site} when it was shared (${ctx.core.today()}).` : '',
          fields: {
            sharing: SharedFrom.parse({ url: finalLink, site, app: body.app ?? null, device: body.device ?? null, sharedAt, price, currency: page?.currency?.slice(0, 3) ?? null }),
          },
        });
        ctx.publish('sharing.added', { productId: product.id, name: product.name, url: finalLink, site });
        return { status: 'added' as const, message: `Added ${product.name} to the wish list.`, productId: product.id, name: product.name, appLink: await appLink(product.id) };
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/:id/confirm',
      summary: 'Keep a shared item on the wish list (it leaves "Shared, to check")',
      params: z.object({ id: z.string() }),
      response: z.object({ productId: z.string(), confirmed: z.boolean() }),
      async handler({ params }) {
        const p = await ctx.core.products.updateField<SharedFrom>(params.id, 'sharing', (cur) => {
          if (!cur) throw new LarderError('That item didn\'t come from a shared link.', 400, 'invalid');
          return { ...cur, confirmed: true };
        });
        return { productId: p.id, confirmed: true };
      },
    });

    async function exists(productId: string, name: string, wish: boolean) {
      return {
        status: 'exists' as const,
        message: wish ? `${name} is already on the wish list.` : `${name} is already in Larder.`,
        productId,
        name,
        appLink: await appLink(productId),
      };
    }
  },
});
