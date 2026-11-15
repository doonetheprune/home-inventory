import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { stockText } from '../format';
import { Empty, ErrorBox, Header, Loading, PlaceText, ProductTile, useAction } from '../ui';

/** Where Scan goes back to after a barcode is saved from here. */
export const NO_BARCODE = '/stock/no-barcode';

/**
 * Things in the house Larder has no barcode for (added by name or by photo, say): scan each one's
 * barcode once, and the next scan knows it. Ones with none (loose fruit, home-made, a tool) can say so.
 */
export function NoBarcode() {
  const { data, error, isLoading } = useQuery({ queryKey: ['products', 'no_barcode', ''], queryFn: () => api.products.list({ status: 'no_barcode' }) });
  const { run, busy } = useAction();
  return (
    <>
      <Header title="No barcode" back="/stock" />
      <div className="content">
        <div className="section">
          <p className="small muted" style={{ margin: 0 }}>Things you have that Larder has no barcode for. Scan each one's barcode or QR code once, and the next scan knows it. Loose fruit, home-made things and tools often have none: say so and they leave this list.</p>
          {isLoading && <Loading />}
          {error ? <ErrorBox error={error} /> : null}
          {data && !data.length && <Empty title="Nothing missing a barcode"><span className="muted small">Larder knows the barcode of everything you have that has one.</span></Empty>}
          {data && data.length > 0 && (
            <div className="list">
              {data.map((s) => (
                <div className="item" key={s.product.id} style={{ flexWrap: 'wrap', rowGap: 2 }}>
                  <Link className="row grow" style={{ gap: 12, minWidth: 0, flex: '1 1 0' }} to={`/products/${s.product.id}`}>
                    <ProductTile s={s} />
                    <span className="item-main">
                      <span className="item-name">{s.product.name}</span>
                      <span className="item-meta">{stockText(s)}{s.places[0] ? <> · <PlaceText p={s.places[0]} /></> : null}</span>
                    </span>
                  </Link>
                  <Link className="btn small primary" style={{ flex: 'none' }} to={`/scan?for=${s.product.id}&back=${encodeURIComponent(NO_BARCODE)}`} aria-label={`Scan ${s.product.name}'s barcode`}><Icon name="scan" size="sm" />Scan</Link>
                  {/* Under the name, so Scan keeps its place beside it on a phone. */}
                  <span style={{ flexBasis: '100%', paddingLeft: 56 }}>
                    <button type="button" className="link small" disabled={busy}
                      onClick={() => run(() => api.products.update(s.product.id, { noBarcode: true }), `${s.product.name} has no barcode. If it gets one, change it on the item.`)}>Hasn't got one</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {data && data.length > 0 && <p className="small muted">{data.length} thing{data.length === 1 ? '' : 's'} to scan.</p>}
        </div>
      </div>
    </>
  );
}

/** On Stock: how many things in the house have no barcode yet, to scan them. Nothing when there are none. */
export function NoBarcodeLink() {
  const count = useQuery({ queryKey: ['products', 'no_barcode', ''], queryFn: () => api.products.list({ status: 'no_barcode' }) }).data?.length ?? 0;
  if (!count) return null;
  return (
    <Link className="card item tosort-link" to={NO_BARCODE}>
      <span className="tile" style={{ background: 'var(--accent-soft)' }}><Icon name="scan" /></span>
      <span className="item-main"><span className="item-name">No barcode</span><span className="item-meta">{count} thing{count === 1 ? '' : 's'} Larder can't scan yet</span></span>
      <span className="pill p-wish">{count}</span>
      <Icon name="chev" className="muted" />
    </Link>
  );
}
