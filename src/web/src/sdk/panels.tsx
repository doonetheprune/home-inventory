/**
 * Panels one module shows on another module's page, without either importing
 * the other: the page names a slot (e.g. "scenarios.scenario") and renders
 * <ModulePanels>; any switched-on module may add a panel to that slot.
 */
import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';
import { useModules } from '../ui';

export interface SlotPanel {
  /** Where it shows: "<module id>.<page>", as the page's docs say, e.g. "scenarios.scenario". */
  slot: string;
  /** Gets the id of what the page shows (e.g. the scenario's id). */
  component: ComponentType<{ id: string }>;
}

/** Every switched-on module's slot panels, provided around module pages. */
export const SlotPanelsContext = createContext<Array<{ moduleId: string; panel: SlotPanel }>>([]);

/** Shows the panels other modules add to this slot (nothing when there are none). */
export function ModulePanels({ slot, id }: { slot: string; id: string }) {
  const panels = useContext(SlotPanelsContext).filter((p) => p.panel.slot === slot);
  return <>{panels.map(({ moduleId, panel: { component: Panel } }, i) => <Panel key={`${moduleId}-${i}`} id={id} />)}</>;
}

/** Whether a module is switched on, e.g. to offer something only when it is. */
export function useModuleEnabled(id: string): boolean {
  return useModules().some((m) => m.id === id && m.enabled);
}
