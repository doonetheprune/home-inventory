/** Finds every module's web.tsx at build time. */
import type { WebModule } from './sdk';
import { useModules } from './ui';

const found = import.meta.glob<{ default: WebModule }>('../../../modules/*/web.tsx', { eager: true });
export const webModules: WebModule[] = Object.values(found).map((m) => m.default).filter(Boolean);

/** Web modules whose server module is switched on. */
export function useEnabledWebModules(): WebModule[] {
  const enabled = new Set(useModules().filter((m) => m.enabled).map((m) => m.id));
  return webModules.filter((m) => enabled.has(m.id));
}
