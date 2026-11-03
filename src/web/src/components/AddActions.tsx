/** Modules' extra ways to add things (Add by photo…), on Home and in the desktop sidebar. */
import { Link, NavLink } from 'react-router-dom';
import { Icon } from '../icons';
import { useEnabledWebModules } from '../modules';
import type { WebModule } from '../sdk';

type AddAction = NonNullable<WebModule['addActions']>[number] & { moduleId: string };

const always = () => true;

function useAddActions(): AddAction[] {
  return useEnabledWebModules().flatMap((m) => (m.addActions ?? []).map((a) => ({ ...a, moduleId: m.id })));
}

function One({ a, place }: { a: AddAction; place: 'home' | 'sidebar' }) {
  // Each action keeps the same hook for its whole life, so calling it here is safe.
  const shown = (a.useShown ?? always)();
  if (!shown) return null;
  const to = `/m/${a.moduleId}${a.path}`;
  if (place === 'sidebar') return <NavLink to={to} className="side-add"><Icon name={a.icon ?? 'plus'} size="sm" />{a.title}</NavLink>;
  return <Link className="act" to={to}><Icon name={a.icon ?? 'plus'} /><div><b>{a.title}</b><br /><span>{a.subtitle}</span></div></Link>;
}

export function AddActions({ place }: { place: 'home' | 'sidebar' }) {
  return <>{useAddActions().map((a) => <One key={`${a.moduleId}${a.path}`} a={a} place={place} />)}</>;
}
