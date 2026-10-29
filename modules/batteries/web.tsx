/** Battery linking UI: which Home Assistant devices use this battery, and their levels. */
import { useState } from 'react';
import { api, defineWebModule, Icon, useAction, useQuery, type ProductDetail } from '@larder/web-sdk';

interface Device {
  id: string; name: string; area: string | null; level: number | null; low: boolean;
  batteryType: string | null; batteryQuantity: number | null; batteries: Array<{ id: string; name: string }>;
}

const isBattery = (p: ProductDetail) => p.product.rechargeable || p.product.haDeviceIds.length > 0 || p.category?.name === 'Batteries' || /batter|cell|cr\d{4}/i.test(p.product.name);

/** "AA batteries" suits a device Battery Notes says takes "AA". */
const suits = (d: Device, p: ProductDetail) => !!d.batteryType && new RegExp(`\\b${d.batteryType.replace(/[^A-Za-z0-9]/g, '')}\\b`, 'i').test(p.product.name.replace(/[^A-Za-z0-9 ]/g, ''));

function UsedIn({ product }: { product: ProductDetail }) {
  const devices = useQuery({ queryKey: ['batteries', 'devices'], queryFn: () => api.modules.call<Device[]>('batteries', 'GET', '/devices') });
  const { run, busy } = useAction();
  const [picking, setPicking] = useState(false);
  if (!isBattery(product)) return null;
  const linked = product.product.haDeviceIds;
  const all = devices.data ?? [];
  const mine = all.filter((d) => linked.includes(d.id));
  const missing = linked.filter((id) => !all.some((d) => d.id === id));
  const others = all.filter((d) => !linked.includes(d.id)).sort((a, b) => Number(suits(b, product)) - Number(suits(a, product)) || a.name.localeCompare(b.name));
  const save = (ids: string[], text: string) => run(() => api.products.update(product.product.id, { haDeviceIds: ids }), text);

  return (
    <div className="section">
      <div className="label">Used in{linked.length ? ` · ${linked.length}` : ''} {all.length > 0 && <button type="button" className="link" onClick={() => setPicking(!picking)}>{picking ? 'Done' : 'Link a device'}</button>}</div>
      {mine.length > 0 && (
        <div className="list">
          {mine.map((d) => (
            <div className="item" key={d.id}>
              <span className="tile"><Icon name="battery" /></span>
              <span className="item-main">
                <span className="item-name">{d.name}</span>
                <span className="item-meta">{[d.area, d.level !== null ? `${d.level}%` : null, d.batteryQuantity ? `takes ${d.batteryQuantity}` : null].filter(Boolean).join(' · ')}{d.low && <span style={{ color: 'var(--low)' }}> · Low</span>}</span>
              </span>
              <button type="button" className="btn small" disabled={busy} onClick={() => void save(linked.filter((x) => x !== d.id), `Unlinked ${d.name}`)}>Unlink</button>
            </div>
          ))}
        </div>
      )}
      {missing.length > 0 && <p className="muted small">{missing.length} linked device{missing.length === 1 ? ' is' : 's are'} no longer reported by Home Assistant.</p>}
      {!all.length && <p className="muted small">Devices with batteries appear here once the Larder integration is set up in Home Assistant. Then Larder can say whether there's a spare when one runs low.</p>}
      {all.length > 0 && !linked.length && !picking && <p className="muted small">Link the devices that take these, and Larder will point to a spare (or put them on the list) when one runs low.</p>}
      {picking && (
        <div className="list">
          {others.map((d) => (
            <button type="button" className="item" key={d.id} disabled={busy} onClick={() => void save([...linked, d.id], `Linked ${d.name}`)}>
              <span className="tile"><Icon name="plus" /></span>
              <span className="item-main">
                <span className="item-name">{d.name}</span>
                <span className="item-meta">{[d.area, d.batteryType ? `Takes ${d.batteryQuantity ?? ''}${d.batteryQuantity ? '× ' : ''}${d.batteryType}` : null, d.level !== null ? `${d.level}%` : null].filter(Boolean).join(' · ')}{d.batteries.length ? ` · uses ${d.batteries.map((b) => b.name).join(', ')}` : ''}</span>
              </span>
              {suits(d, product) && <span className="pill p-ok">Matches</span>}
            </button>
          ))}
          {!others.length && <div className="item"><span className="muted small">Every device with a battery is linked already.</span></div>}
        </div>
      )}
    </div>
  );
}

export default defineWebModule({ id: 'batteries', productPanels: [UsedIn] });
