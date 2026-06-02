import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TelescopeProvider } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';
import { EntriesPage } from './pages/entries-page.js';
import { EntryPage } from './pages/entry-page.js';

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
              <Route
                path="/pulse"
                element={<div className="p-6 text-zinc-500">Pulse — coming next.</div>}
              />
              <Route
                path="/queues"
                element={<div className="p-6 text-zinc-500">Queues — coming next.</div>}
              />
            </Routes>
          </DashboardLayout>
        </HashRouter>
      </QueryClientProvider>
    </TelescopeProvider>
  );
}
