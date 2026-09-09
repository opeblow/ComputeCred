import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from './hooks/useConfig';
import AppShell from './app/AppShell';
import OverviewPage from './app/features/overview/OverviewPage';
import FacilityPage from './app/features/facility/FacilityPage';
import SettlementsPage from './app/features/settlements/SettlementsPage';
import BuyersPage from './app/features/buyers/BuyersPage';
import ActivityPage from './app/features/activity/ActivityPage';
import SettingsPage from './app/features/settings/SettingsPage';

import './styles/tokens.css';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true },
  },
});

function Root() {
  return (
    <ConfigProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<OverviewPage />} />
              <Route path="facility" element={<FacilityPage />} />
              <Route path="settlements" element={<SettlementsPage />} />
              <Route path="buyers" element={<BuyersPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing root');
import { createRoot } from 'react-dom/client';
createRoot(root).render(<Root />);