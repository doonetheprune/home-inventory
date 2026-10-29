/** Pick an item by typing part of its name or alias. */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProductSummary } from '@larder/core';
import { api } from '../api';
import { stockText } from '../format';
import { ProductTile } from '../ui';

export function ProductPicker({ onPick, only, placeholder = 'Which item?' }: { onPick: (s: ProductSummary) => void; only?: (s: ProductSummary) => boolean; placeholder?: string }) {
  const { data } = useQuery({ queryKey: ['products', 'all', ''], queryFn: () => api.products.list({ status: 'all' }) });
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data ?? [])
      .filter((s) => !only || only(s))
      .filter((s) => words.every((w) => [s.product.name, ...s.product.aliases].join(' ').toLowerCase().includes(w)))
      .slice(0, 6);
  }, [data, q, only]);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <div className="list">
        {matches.map((s) => (
          <button type="button" key={s.product.id} className="item" style={{ textAlign: 'left', width: '100%' }} onClick={() => onPick(s)}>
            <ProductTile s={s} />
            <span className="item-main"><span className="item-name">{s.product.name}</span><span className="item-meta">{s.places[0]?.path ?? 'No place set'}</span></span>
            <span className="qty">{stockText(s)}</span>
          </button>
        ))}
        {!matches.length && <div className="item"><span className="muted small">{q ? `Nothing in the house matches “${q}”.` : 'Nothing to pick yet.'}</span></div>}
      </div>
    </div>
  );
}
