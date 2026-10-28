/** The app frame: top bar with search, sidebar (big screens) or tab bar (phones). */
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../icons';
import { dayDate } from '../format';
import { GlobalSearch } from './GlobalSearch';
import { useEnabledWebModules } from '../modules';

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** USB and Bluetooth barcode scanners type fast and press Enter. Catch that anywhere. */
function useScannerWedge() {
  const navigate = useNavigate();
  useEffect(() => {
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      const now = performance.now();
      if (now - last > 60) buf = '';
      last = now;
      if (e.key === 'Enter') {
        if (buf.length >= 6) {
          e.preventDefault();
          navigate(`/scan?code=${encodeURIComponent(buf)}`);
        }
        buf = '';
      } else if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

export function Shell() {
  const location = useLocation();
  const screen = useRef<HTMLElement>(null);
  const atHome = location.pathname === '/';
  const pages = useEnabledWebModules().flatMap((m) => (m.pages ?? []).map((p) => ({ ...p, moduleId: m.id })));
  useScannerWedge();

  useEffect(() => {
    screen.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const tab = (to: string, icon: string, label: string, t: string, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `tab ${isActive ? 'on' : ''}`} data-t={t}>
      <Icon name={icon} />{label}
    </NavLink>
  );

  return (
    <div className="frame">
      <div className={`app ${atHome ? 'at-home' : ''}`}>
        <header className="topbar">
          <NavLink to="/" className="tb-brand" aria-label="Larder home"><span className="mark"><Icon name="jar" /></span><b>Larder</b></NavLink>
          <span className="tb-date">{dayDate(todayIso())}</span>
          <GlobalSearch />
        </header>
        <main className="screen" ref={screen}>
          <Outlet />
        </main>
        <nav className="tabbar" aria-label="Main">
          {tab('/', 'home', 'Home', 'home', true)}
          {tab('/stock', 'box', 'Stock', 'stock')}
          <NavLink to="/scan" className={({ isActive }) => `tab scan ${isActive ? 'on' : ''}`} data-t="scan" aria-label="Scan">
            <span className="fab"><Icon name="scan" /><span className="side-label">Scan</span></span>
          </NavLink>
          <NavLink to="/add" className="side-add"><Icon name="plus" size="sm" />Add by name</NavLink>
          {tab('/shop', 'cart', 'Shop', 'shop')}
          {tab('/more', 'more', 'More', 'more')}
          <div className="side-group">
            <span className="side-head">Organise</span>
            {tab('/places', 'pin', 'Places', 'x')}
            {tab('/shops', 'store', 'Shops', 'x')}
            {tab('/wishlist', 'heart', 'Wish list', 'x')}
            {pages.map((p) => tab(`/m/${p.moduleId}${p.path}`, p.icon ?? 'box', p.title, 'x'))}
            <span className="side-head">Household</span>
            {tab('/settings', 'sliders', 'Settings', 'x')}
          </div>
        </nav>
      </div>
    </div>
  );
}
