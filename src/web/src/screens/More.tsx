import { Link } from 'react-router-dom';
import { Icon } from '../icons';
import { useEnabledWebModules } from '../modules';
import { Header, useCategories } from '../ui';

export function More() {
  const renewals = useCategories().find((c) => c.name === 'Renewals');
  const pages = useEnabledWebModules().flatMap((m) => (m.pages ?? []).map((p) => ({ ...p, moduleId: m.id })));
  const tile = (to: string, icon: string, title: string, sub: string) => (
    <Link to={to}><span className="tile"><Icon name={icon} /></span><b>{title}</b><span className="muted">{sub}</span></Link>
  );
  return (
    <>
      <Header title="More" />
      <div className="content">
        <div className="more-grid">
          {tile('/places', 'pin', 'Places', 'Rooms, shelves and boxes')}
          {tile('/shops', 'store', 'Shops', 'And what each sells')}
          {tile('/wishlist', 'heart', 'Wish list', 'Wanted, not owned')}
          {renewals && tile(`/stock?category=${renewals.id}`, 'shield', 'Renewals', 'Insurance, MOT')}
          {tile('/grid', 'grid', 'Shelves & boxes', 'Set up storage codes')}
          {pages.map((p) => tile(`/m/${p.moduleId}${p.path}`, p.icon ?? 'box', p.title, 'Module'))}
          {tile('/settings', 'sliders', 'Settings', 'Household, modules, tokens')}
        </div>
      </div>
    </>
  );
}
