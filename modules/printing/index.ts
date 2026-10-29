/**
 * Printing: QR label sheets for places and items.
 *
 * Pick a place (with everything inside it, such as all 24 boxes of the
 * garage racking) or a batch of items, then a sheet layout (common Avery
 * sizes, or plain A4 with cut lines). Each label has a QR code that Larder's
 * scanner opens; with LARDER_BASE_URL set it's a link a phone's own camera
 * opens too. The sheets themselves are drawn by the web app (web.tsx).
 */
import { z } from 'zod';
import { defineModule, Id, type PlaceNodeT } from '@larder/core';

export const Label = z.object({
  kind: z.enum(['place', 'product']),
  id: z.string(),
  /** Big text on the label, e.g. "G2-4" (or the name when there's no code). */
  code: z.string().nullable(),
  title: z.string(),
  /** Smaller text, e.g. "Garage › Racking". */
  subtitle: z.string(),
}).meta({ id: 'Label' });
export type Label = z.infer<typeof Label>;

export const StorageArea = z.object({ id: z.string(), name: z.string(), path: z.string(), labels: z.number() }).meta({ id: 'StorageArea' });

const byCode = (a: Label, b: Label) => (a.code ?? a.title).localeCompare(b.code ?? b.title, 'en', { numeric: true });

function flatten(nodes: PlaceNodeT[]): PlaceNodeT[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

export default defineModule({
  id: 'printing',
  name: 'Printing',
  description: 'QR label sheets for places and items, on Avery label sheets or plain A4 with cut lines.',
  version: '1.0.0',
  setup(ctx) {
    const core = ctx.core;

    const placeLabel = (n: PlaceNodeT): Label => {
      const parent = n.path.split(' › ').slice(0, -1).join(' › ');
      return { kind: 'place', id: n.place.id, code: n.place.code, title: n.place.name, subtitle: parent };
    };

    ctx.addRoute({
      method: 'GET', path: '/areas', summary: 'Places worth labelling in one go: anything with places inside it',
      response: z.array(StorageArea),
      async handler() {
        const all = flatten(await core.places.tree());
        return all
          .filter((n) => n.children.length > 0)
          .map((n) => ({ id: n.place.id, name: n.place.name, path: n.path, labels: flatten(n.children).length }))
          .sort((a, b) => b.labels - a.labels || a.path.localeCompare(b.path));
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/labels', summary: 'Labels for a place and everything inside it, and/or chosen items',
      description: 'place: a place id (its own label plus one for each place inside it). products: comma-separated item ids.',
      query: z.object({ place: Id.optional(), products: z.string().max(10_000).optional() }),
      response: z.array(Label),
      async handler({ query }) {
        const q = query as { place?: string; products?: string };
        const out: Label[] = [];
        if (q.place) {
          const node = flatten(await core.places.tree()).find((n) => n.place.id === q.place);
          if (node) {
            // The storage itself first, then what's inside it in code order (G1-1, G1-2 … G4-6).
            out.push(placeLabel(node), ...flatten(node.children).map(placeLabel).sort(byCode));
          }
        }
        for (const id of (q.products ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
          const s = await core.products.summary(id).catch(() => null);
          if (s) out.push({ kind: 'product', id, code: null, title: s.product.name, subtitle: s.places[0]?.path ?? s.category?.name ?? '' });
        }
        return out;
      },
    });
  },
});
