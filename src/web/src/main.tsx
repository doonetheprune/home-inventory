import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { HashRouter, Route, Routes } from 'react-router-dom';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import { api, onAuthRequired } from './api';
import { ToastProvider, Loading, useLiveUpdates } from './ui';
import { Shell } from './components/Shell';
import { Login } from './screens/Login';
import { Home } from './screens/Home';
import { Stock } from './screens/Stock';
import { ProductPage } from './screens/Product';
import { ProductEdit } from './screens/ProductEdit';
import { AddItem } from './screens/AddItem';
import { Scan } from './screens/Scan';
import { Shopping } from './screens/Shopping';
import { Places } from './screens/Places';
import { PlacePage } from './screens/Place';
import { GridWizard } from './screens/GridWizard';
import { Shops } from './screens/Shops';
import { WishList } from './screens/WishList';
import { Settings } from './screens/Settings';
import { More } from './screens/More';
import { ModulePage } from './screens/ModulePage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, err) => n < 2 && (err as { status?: number }).status !== 401 && (err as { status?: number }).status !== 404, refetchOnWindowFocus: true } },
});

function App() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: api.auth.status });
  const [, force] = useState(0);
  useEffect(() => onAuthRequired(() => {
    void qc.invalidateQueries({ queryKey: ['auth'] });
    force((n) => n + 1);
  }), [qc]);
  const signedIn = !!status.data?.user;
  useLiveUpdates(signedIn);

  if (status.isLoading) return <Loading />;
  if (status.error) return <div className="login"><div className="card"><b>Can't reach Larder.</b><p className="muted">Check that the server is running, then reload.</p></div></div>;
  if (!signedIn) return <Login status={status.data!} />;

  return (
    <HashRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="stock" element={<Stock />} />
          <Route path="products/:id" element={<ProductPage />} />
          <Route path="products/:id/edit" element={<ProductEdit />} />
          <Route path="add" element={<AddItem />} />
          <Route path="scan" element={<Scan />} />
          <Route path="shop" element={<Shopping />} />
          <Route path="shop/:shopId" element={<Shopping />} />
          <Route path="places" element={<Places />} />
          <Route path="places/:id" element={<PlacePage />} />
          <Route path="grid" element={<GridWizard />} />
          <Route path="shops" element={<Shops />} />
          <Route path="wishlist" element={<WishList />} />
          <Route path="settings" element={<Settings />} />
          <Route path="more" element={<More />} />
          <Route path="m/:moduleId/*" element={<ModulePage />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
