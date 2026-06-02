import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TelescopeProvider } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';
import { EntriesPage } from './pages/entries-page.js';
import { EntryPage } from './pages/entry-page.js';
import { PulsePage } from './pages/pulse-page.js';
import { QueuesPage } from './pages/queues-page.js';

const queryClient = new QueryClient();

export function App(): JSX.Element {
  return (
    <TelescopeProvider>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <DashboardLayout>
            <Routes>
              <Route path="/" element={<Navigate to="/entries" replace />} />
              <Route path="/entries" element={<EntriesPage />} />
              <Route path="/entries/:id" element={<EntryPage />} />
              <Route path="/pulse" element={<PulsePage />} />
              <Route path="/queues" element={<QueuesPage />} />
            </Routes>
          </DashboardLayout>
        </HashRouter>
      </QueryClientProvider>
    </TelescopeProvider>
  );
}
