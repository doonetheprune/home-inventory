import { useParams } from 'react-router-dom';
import { useEnabledWebModules } from '../modules';
import { Empty, Header } from '../ui';

export function ModulePage() {
  const { moduleId, '*': rest } = useParams();
  const page = useEnabledWebModules().find((m) => m.id === moduleId)?.pages?.find((p) => p.path === `/${rest ?? ''}`);
  if (!page) return <><Header title="Not found" back="/more" /><div className="content"><Empty title="That page isn't available"><span className="small muted">Its module may be switched off in Settings.</span></Empty></div></>;
  const Page = page.component;
  return <Page />;
}
