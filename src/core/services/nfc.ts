/**
 * NFC tags on products and places.
 *
 * Phones read tags (the Home Assistant app fires `tag_scanned`; Android
 * Chrome can read them directly), then report them here. A known tag
 * resolves to its product or place; an unknown one is kept for a while so the
 * person can link it from the product or place page.
 */
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IsoDateTime } from '../model';
import type { CoreContext } from './context';
import type { createProductService } from './products';
import { placePath } from './world';
import { unique } from '../util';

export const NfcScan = z.object({
  tagId: z.string(),
  at: IsoDateTime,
  /** The phone or reader that scanned it, if known. */
  device: z.string().nullable(),
  kind: z.enum(['product', 'place', 'unknown']),
  id: z.string().nullable(),
  name: z.string().nullable(),
});
export type NfcScan = z.infer<typeof NfcScan>;

/** How long an unknown tag is offered for linking. */
const RECENT_MINUTES = 15;
const KEEP = 20;

export function createNfcService(ctx: CoreContext, products: ReturnType<typeof createProductService>) {
  async function owner(tagId: string) {
    const product = await ctx.storage.products.findByNfcTag(tagId);
    if (product) return { kind: 'product' as const, id: product.id, name: product.name };
    const place = await ctx.storage.places.findByNfcTag(tagId);
    if (place) {
      const places = await ctx.storage.places.list();
      return { kind: 'place' as const, id: place.id, name: place.name, path: placePath(new Map(places.map((p) => [p.id, p])), place.id) };
    }
    return null;
  }

  const clean = (tagId: string) => {
    const t = tagId.trim();
    if (!t) throw new ValidationError('The NFC tag id is empty.');
    if (t.length > 200) throw new ValidationError('That NFC tag id is too long.');
    return t;
  };

  return {
    /** A tag was scanned somewhere. Publishes `nfc.scanned`. */
    async scanned(input: { tagId: string; device?: string | null }): Promise<NfcScan & { path: string | null }> {
      const tagId = clean(input.tagId);
      const found = await owner(tagId);
      const scan: NfcScan = { tagId, at: ctx.now(), device: input.device?.trim() || null, kind: found?.kind ?? 'unknown', id: found?.id ?? null, name: found?.name ?? null };
      const recent = (await ctx.storage.settings.get<NfcScan[]>('nfcRecent')) ?? [];
      await ctx.storage.settings.set('nfcRecent', [scan, ...recent.filter((r) => r.tagId !== tagId)].slice(0, KEEP));
      const path = found && 'path' in found ? (found.path ?? null) : null;
      ctx.publish('nfc.scanned', { ...scan, path });
      return { ...scan, path };
    },

    /** Tags scanned in the last few minutes, newest first, with what they belong to now. */
    async recent(): Promise<NfcScan[]> {
      const since = Date.parse(ctx.now()) - RECENT_MINUTES * 60_000;
      const recent = ((await ctx.storage.settings.get<NfcScan[]>('nfcRecent')) ?? []).filter((r) => Date.parse(r.at) >= since);
      return Promise.all(recent.map(async (r) => {
        const found = await owner(r.tagId);
        return { ...r, kind: found?.kind ?? 'unknown', id: found?.id ?? null, name: found?.name ?? null };
      }));
    },

    /** Link a tag to a product or a place. A tag belongs to one thing at a time. */
    async link(input: { tagId: string; productId?: string; placeId?: string }) {
      const tagId = clean(input.tagId);
      if (!input.productId === !input.placeId) throw new ValidationError('Link the tag to either a product or a place.');
      const current = await owner(tagId);
      if (current && current.id !== (input.productId ?? input.placeId)) throw new ConflictError(`That tag is already linked to ${current.name}. Unlink it there first.`);
      if (input.productId) return { kind: 'product' as const, product: await products.addNfcTag(input.productId, tagId) };
      const place = await ctx.storage.places.get(input.placeId!);
      if (!place) throw new NotFoundError('Place', input.placeId!);
      const next = { ...place, nfcTags: unique([...place.nfcTags, tagId]), updatedAt: ctx.now() };
      await ctx.storage.places.put(next);
      ctx.publish('place.changed', { id: place.id });
      return { kind: 'place' as const, place: next };
    },

    /** Forget a tag wherever it's linked. */
    async unlink(tagId: string): Promise<{ unlinked: boolean }> {
      const t = clean(tagId);
      const product = await ctx.storage.products.findByNfcTag(t);
      if (product) {
        await products.update(product.id, { nfcTags: product.nfcTags.filter((x) => x !== t) });
        return { unlinked: true };
      }
      const place = await ctx.storage.places.findByNfcTag(t);
      if (place) {
        await ctx.storage.places.put({ ...place, nfcTags: place.nfcTags.filter((x) => x !== t), updatedAt: ctx.now() });
        ctx.publish('place.changed', { id: place.id });
        return { unlinked: true };
      }
      return { unlinked: false };
    },
  };
}
