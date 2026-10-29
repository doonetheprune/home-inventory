/** Helpers for module pages: URL parameters, and print page set-up. */
import { createContext, useContext, useEffect } from 'react';

export { matchPath } from './paths';

export const ModuleParamsContext = createContext<Record<string, string>>({});

/** Parameters from a page path like "/:id/print". */
export function useModuleParams(): Record<string, string> {
  return useContext(ModuleParamsContext);
}

/**
 * While a print page is open: A4 paper with these margins, and only the
 * `.print-area` element prints (no app chrome). Label sheets need zero margins.
 */
export function PrintSetup({ margin = '12mm' }: { margin?: string }) {
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `@page { size: A4; margin: ${margin}; }`;
    document.head.appendChild(style);
    document.body.classList.add('printing-page');
    return () => {
      style.remove();
      document.body.classList.remove('printing-page');
    };
  }, [margin]);
  return null;
}
