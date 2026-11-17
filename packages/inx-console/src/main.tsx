import './index.css';

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';

import { api, ApiError, type Status } from './api';
import { Login } from './pages/Login';
import { MachineDetail } from './pages/machines/MachineDetail';
import { Machines } from './pages/machines/Machines';
import { Setup } from './pages/Setup';
import { Shell } from './pages/Shell';
import { Placeholder } from './ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2, refetchOnWindowFocus: false }
  }
});

// A 401 from any API call means the session ended: refresh status so the guard redirects to login.
queryClient.getQueryCache().subscribe(event => {
  if (event.type === 'updated' && event.query.queryKey[0] !== 'status' && event.action.type === 'error' && event.action.error instanceof ApiError && event.action.error.status === 401) {
    void queryClient.invalidateQueries({ queryKey: ['status'] });
  }
});

// Routes the visitor to setup, login, or the console depending on server state.
function Gate({ area }: { area: 'setup' | 'login' | 'app' }) {
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/status') });
  const location = useLocation();
  if (status.isPending) return null;
  if (status.isError) return <p className="p-8 text-sm text-red-600">无法连接到 INX Connect 服务。</p>;
  const { initialized, authenticated } = status.data;
  // A setup link also resets a forgotten password, so it stays reachable after initialization.
  const target = !initialized ? 'setup' : authenticated ? 'app' : area === 'setup' && location.search.includes('code=') ? 'setup' : 'login';
  if (target !== area) return <Navigate to={target === 'app' ? '/' : '/' + target} replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  { element: <Gate area="setup" />, children: [{ path: '/setup', element: <Setup /> }] },
  { element: <Gate area="login" />, children: [{ path: '/login', element: <Login /> }] },
  {
    element: <Gate area="app" />,
    children: [
      {
        element: <Shell />,
        children: [
          { index: true, element: <Navigate to="/machines" replace /> },
          { path: '/machines', element: <Machines /> },
          { path: '/machines/:id', element: <MachineDetail /> },
          { path: '/nodes', element: <Placeholder title="节点" description="节点导入与管理将在机器接入完成后提供。" /> },
          { path: '/subscriptions', element: <Placeholder title="订阅" description="跨机器组合订阅将在节点管理完成后提供。" /> },
          { path: '*', element: <Navigate to="/machines" replace /> }
        ]
      }
    ]
  }
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
