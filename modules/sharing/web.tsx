/**
 * Pending: links shared from a phone, waiting to go on the wish list or into
 * Larder. A link to it from the Wish list, and where an item came from on its page.
 */
import {
  api, defineWebModule, Empty, Header, Icon, Link, Loading, ModulePanels, money, shortDate, useAction, useAddItem, useQuery, type ProductDetail,
} from '@larder/web-sdk';

interface SharedFrom { url: string; site: string; app: string | null; device: string | null; sharedAt: string; price: number | null; currency: string | null }
interface PendingShare extends SharedFrom { id: string; name: string; photoFileId: string | null }

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('sharing', method, path, body);
function usePending() {
  return useQuery({ queryKey: ['sharing', 'pending'], queryFn: () => call<PendingShare[]>('GET', '/pending') });
}

function PendingPage() {
  const { data, isLoading } = usePending();
  const { run, busy } = useAction();
  const addItem = useAddItem();

  /** Got it already: the Add item page, filled in from the share; saving takes it out of Pending. */
  const intoLarder = (p: PendingShare) => addItem({
    name: p.name,
    links: [p.url],
    notes: p.price !== null ? `${money(p.price, p.currency ?? 'GBP')} at ${p.site} when it was shared (${shortDate(p.sharedAt.slice(0, 10))}).` : '',
    photoFileId: p.photoFileId,
    note: `Shared from ${p.site}. Say how many you've got and where, and it leaves Pending.`,
    onSaved: (productId) => call('POST', `/pending/${encodeURIComponent(p.id)}/added`, { productId }),
  });

  return (
    <>
      <Header title="Pending" back="/more" />
      <div className="content" style={{ maxWidth: 860 }}>
        <p className="small muted">Links shared from your phone to Home Assistant. Put each on the wish list, or add it to Larder if you've got it.</p>
        {isLoading && <Loading />}
        {data && !data.length && (
          <Empty title="No shared links waiting">
            <span className="muted small">On Android, share a page from a shop's app or Chrome to Home Assistant, and it waits here.</span>
          </Empty>
        )}
        <div className="list">
          {(data ?? []).map((p) => (
            <div className="item" key={p.id} style={{ flexWrap: 'wrap' }}>
              <span className="tile">{p.photoFileId ? <img src={api.files.url(p.photoFileId)} alt="" loading="lazy" /> : <Icon name="link" />}</span>
              <span className="item-main" style={{ flex: '1 1 180px' }}>
                <span className="item-name">{p.name}</span>
                <span className="item-meta">
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{p.site}</a>
                  {` · shared ${shortDate(p.sharedAt.slice(0, 10))}`}{p.price !== null ? ` · ${money(p.price, p.currency ?? 'GBP')}` : ''}
                </span>
              </span>
              <div className="row" style={{ gap: 6, rowGap: 6, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button type="button" className="btn small primary" disabled={busy}
                  onClick={() => void run(() => call('POST', `/pending/${encodeURIComponent(p.id)}/wish`), `${p.name} is on the wish list`)}>
                  <Icon name="heart" size="sm" />Add to wish list
                </button>
                <button type="button" className="btn small" disabled={busy} onClick={() => intoLarder(p)}><Icon name="plus" size="sm" />Add to Larder</button>
                <button type="button" className="iconbtn ghost" aria-label={`Not wanted: remove ${p.name}`} disabled={busy}
                  onClick={() => void run(() => call('DELETE', `/pending/${encodeURIComponent(p.id)}`), `${p.name} removed`)}>
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </div>
          ))}
        </div>
        {/* Other modules' waiting things, e.g. shop favourites from online shopping. */}
        <ModulePanels slot="sharing.pending" id="" />
      </div>
    </>
  );
}

/** On the Wish list: how many shared links are waiting. */
function PendingOnWishList() {
  const n = usePending().data?.length ?? 0;
  if (!n) return null;
  return (
    <Link className="card pad" to="/m/sharing/" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
      <Icon name="inbox" />
      <span style={{ flex: 1, minWidth: 0 }}><b>{n === 1 ? '1 shared link' : `${n} shared links`} in Pending</b><br /><span className="small muted">Put them on the wish list, or add them to Larder</span></span>
      <Icon name="chev" size="sm" />
    </Link>
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
  pages: [{ path: '/', title: 'Pending', icon: 'inbox', subtitle: 'Shared links to sort', section: 'wishlist', component: PendingPage }],
  wishListPanels: [PendingOnWishList],
  productPanels: [SharedPanel],
});
