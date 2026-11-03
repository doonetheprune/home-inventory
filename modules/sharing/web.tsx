/** On an item that came from a shared link: where from, when, and the price then. */
import { defineWebModule, Icon, money, shortDate, type ProductDetail } from '@larder/web-sdk';

interface SharedFrom { url: string; site: string; app: string | null; device: string | null; sharedAt: string; price: number | null; currency: string | null }

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

export default defineWebModule({ id: 'sharing', productPanels: [SharedPanel] });
