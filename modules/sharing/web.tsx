/**
 * Shared links on the Wish list waiting to be checked ("Yes, add" or "Already
 * got"), and where an item came from on its page.
 */
import {
  api, defineWebModule, Icon, Link, money, ProductTile, shortDate, useAction, useAddItem, useQuery, type ProductDetail, type ProductSummary,
} from '@larder/web-sdk';

interface SharedFrom { url: string; site: string; app: string | null; device: string | null; sharedAt: string; price: number | null; currency: string | null; confirmed?: boolean }

const shared = (s: ProductSummary) => s.product.fields.sharing as SharedFrom | undefined;
/** On the wish list from a share, and not yet said yes to. */
const toCheck = (s: ProductSummary) => s.product.wish && !!shared(s)?.url && !shared(s)?.confirmed;

function SharedToCheck() {
  const { data } = useQuery({ queryKey: ['products', 'wish'], queryFn: () => api.products.list({ status: 'wish' }) });
  const { run, busy } = useAction();
  const addItem = useAddItem();
  const waiting = (data ?? []).filter(toCheck);
  if (!waiting.length) return null;

  /** Got it already: the Add item screen, filled in from the item, saves into it with how many and where. */
  const alreadyGot = (s: ProductSummary) => addItem({
    productId: s.product.id,
    name: s.product.name,
    aliases: s.product.aliases,
    categoryId: s.product.categoryId,
    unit: s.product.unit,
    shelfLifeDays: s.product.shelfLifeDays,
    preferredShopIds: s.product.preferredShopIds,
    links: s.product.links.map((l) => l.url),
    notes: s.product.notes,
    defaultPlaceId: s.product.defaultPlaceId,
    photoFileId: s.product.photoFileIds[0] ?? null,
    note: 'You’ve got this already: say how many and where, and it comes off the wish list.',
  });

  return (
    <div className="section">
      <div className="label">Shared, to check</div>
      <p className="small muted">Shared from your phone. Keep each on the wish list, or say you’ve already got one.</p>
      <div className="list">
        {waiting.map((s) => {
          const from = shared(s)!;
          return (
            <div className="item" key={s.product.id} style={{ flexWrap: 'wrap' }}>
              <ProductTile s={s} />
              <Link className="item-main" style={{ flex: '1 1 180px' }} to={`/products/${s.product.id}`}>
                <span className="item-name">{s.product.name}</span>
                <span className="item-meta">{[from.site, `shared ${shortDate(from.sharedAt.slice(0, 10))}`, from.price !== null ? money(from.price, from.currency ?? 'GBP') : null].filter(Boolean).join(' · ')}</span>
              </Link>
              <div className="row" style={{ gap: 6, marginLeft: 'auto', rowGap: 6 }}>
                <button type="button" className="btn small primary" disabled={busy}
                  onClick={() => void run(() => api.modules.call('sharing', 'POST', `/${encodeURIComponent(s.product.id)}/confirm`), `${s.product.name} is on the wish list`)}>
                  Yes, add
                </button>
                <button type="button" className="btn small" disabled={busy} onClick={() => alreadyGot(s)}>Already got</button>
                <button type="button" className="iconbtn ghost" aria-label={`Not wanted: remove ${s.product.name}`} disabled={busy}
                  onClick={() => void run(() => api.products.remove(s.product.id), `${s.product.name} removed`)}>
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SharedPanel({ product }: { product: ProductDetail }) {
  const s = product.product.fields.sharing as SharedFrom | undefined;
  if (!s?.url) return null;
  const when = shortDate(s.sharedAt.slice(0, 10));
  return (
    <div className="card pad stack" style={{ gap: 6 }}>
      <div className="label" style={{ margin: 0 }}>From a shared link</div>
      <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>
        <Icon name="link" size="sm" />{s.site}
      </a>
      <span className="small muted">
        Shared {when}{s.device ? ` from ${s.device}` : ''}{s.price !== null ? ` · ${money(s.price, s.currency ?? 'GBP')} then` : ''}
      </span>
    </div>
  );
}

export default defineWebModule({
  id: 'sharing',
  productPanels: [SharedPanel],
  wishList: { panels: [SharedToCheck], hides: toCheck },
});
