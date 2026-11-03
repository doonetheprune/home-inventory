import { useParams } from 'react-router-dom';
import { useEnabledWebModules } from '../modules';
import { matchPath, ModuleParamsContext } from '../sdk/page';
import { SlotPanelsContext } from '../sdk/panels';
import { Empty, Header } from '../ui';

export function ModulePage() {
  const { moduleId, '*': rest } = useParams();
  const enabled = useEnabledWebModules();
  const pages = enabled.find((m) => m.id === moduleId)?.pages ?? [];
  const slotPanels = enabled.flatMap((m) => (m.panels ?? []).map((panel) => ({ moduleId: m.id, panel })));
  const path = `/${rest ?? ''}`;
  const found = pages.map((p) => ({ page: p, params: matchPath(p.path, path) })).find((x) => x.params);
  if (!found) return <><Header title="Not found" back="/more" /><div className="content"><Empty title="That page isn't available"><span className="small muted">Its module may be switched off in Settings.</span></Empty></div></>;
  const Page = found.page.component;
  return (
    <SlotPanelsContext.Provider value={slotPanels}>
      <ModuleParamsContext.Provider value={found.params!}><Page /></ModuleParamsContext.Provider>
    </SlotPanelsContext.Provider>
  );
}
