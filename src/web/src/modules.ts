/** Finds every module's web.tsx at build time. */
import type { WebModule } from './sdk';
import { useModules } from './ui';
import { useOpenCopy } from './offline/current';

const found = import.meta.glob<{ default: WebModule }>('../../../modules/*/web.tsx', { eager: true });
export const webModules: WebModule[] = Object.values(found).map((m) => m.default).filter(Boolean);

/** Web modules whose server module is switched on (and, in a saved copy, that work from one). */
export function useEnabledWebModules(): WebModule[] {
  const enabled = new Set(useModules().filter((m) => m.enabled).map((m) => m.id));
  const copy = useOpenCopy();
  return webModules.filter((m) => enabled.has(m.id) && (!copy || m.offline));
}
