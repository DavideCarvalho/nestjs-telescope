import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { TelescopeProvider } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { QueueManagerPage } from './pages/QueueManagerPage.js';
import { EntriesPage } from './pages/entries-page.js';
import { EntryPage } from './pages/entry-page.js';
import { PulsePage } from './pages/pulse-page.js';
import { QueuesPage } from './pages/queues-page.js';
import { QueuesShell } from './pages/queues-shell.js';
import { SchedulesPage } from './pages/schedules-page.js';
import { TracePage } from './pages/trace-page.js';
import { TracesPage } from './pages/traces-page.js';
import { ThemeProvider } from './theme-context.js';

const queryClient = new QueryClient();

export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <TelescopeProvider>
        <QueryClientProvider client={queryClient}>
          <HashRouter>
            <DashboardLayout>
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/entries" element={<EntriesPage />} />
                <Route path="/entries/view/:id" element={<EntryPage />} />
                <Route path="/entries/:type" element={<EntriesPage />} />
                <Route path="/traces" element={<TracesPage />} />
                <Route path="/traces/:traceId" element={<TracePage />} />
                <Route path="/pulse" element={<PulsePage />} />
                <Route path="/queues" element={<QueuesShell />}>
                  <Route index element={<QueueManagerPage />} />
                  <Route path="metrics" element={<QueuesPage />} />
                </Route>
                <Route path="/schedules" element={<SchedulesPage />} />
              </Routes>
            </DashboardLayout>
          </HashRouter>
        </QueryClientProvider>
      </TelescopeProvider>
    </ThemeProvider>
  );
}
