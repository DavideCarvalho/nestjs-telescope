import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import { notifyHashUrl } from '../aviary-kit/url-state/hash-url';
import { NuqsHashAdapter } from '../aviary-kit/url-state/nuqs-hash-adapter';
import { TelescopeProvider } from '../react/index.js';
import { AccessGate } from './access-denied.js';
import { DashboardLayout } from './dashboard-layout.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { QueueManagerPage } from './pages/QueueManagerPage.js';
import { AiPage } from './pages/ai-page.js';
import { EntriesPage } from './pages/entries-page.js';
import { EntryPage } from './pages/entry-page.js';
import { ExportsPage } from './pages/exports-page.js';
import { ExtensionDashboardPage } from './pages/extension-dashboard-page.js';
import { FleetPage } from './pages/fleet-page.js';
import { ProfilesPage } from './pages/profiles-page.js';
import { PrunesPage } from './pages/prunes-page.js';
import { PulsePage } from './pages/pulse-page.js';
import { QueuesPage } from './pages/queues-page.js';
import { QueuesShell } from './pages/queues-shell.js';
import { SchedulesPage } from './pages/schedules-page.js';
import { TracePage } from './pages/trace-page.js';
import { TracesPage } from './pages/traces-page.js';
import { ThemeProvider } from './theme-context.js';

const queryClient = new QueryClient();

/**
 * react-router's `HashRouter` navigates with `history.pushState`, which fires no event, so after
 * each of its navigations tell the kit's URL state: a page's filters follow a link like
 * `#/entries/query?familyHash=…` even when the page stays mounted.
 */
function RouterUrlSync(): null {
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per navigation
  useLayoutEffect(() => notifyHashUrl(), [location]);
  return null;
}

/**
 * Routing is react-router's `HashRouter` (`#/entries/query`); a page's view state (filters,
 * search, tab, time window, selected queue/profile/run) is the hash's query
 * (`#/entries?tag=user:42&q=orders`), read and written with nuqs through the kit's
 * `NuqsHashAdapter`, so a filtered view is a link.
 */
function Dashboard(): React.JSX.Element {
  return (
    <HashRouter>
      <RouterUrlSync />
      <NuqsHashAdapter>
        <DashboardLayout>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/entries" element={<EntriesPage />} />
            <Route path="/entries/view/:id" element={<EntryPage />} />
            <Route path="/entries/:type" element={<EntriesPage />} />
            <Route path="/traces" element={<TracesPage />} />
            <Route path="/traces/:traceId" element={<TracePage />} />
            <Route path="/pulse" element={<PulsePage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/ai" element={<AiPage />} />
            <Route path="/queues" element={<QueuesShell />}>
              <Route index element={<QueueManagerPage />} />
              <Route path="metrics" element={<QueuesPage />} />
            </Route>
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/prunes" element={<PrunesPage />} />
            <Route path="/exports" element={<ExportsPage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/ext/:dashboardId" element={<ExtensionDashboardPage />} />
          </Routes>
        </DashboardLayout>
      </NuqsHashAdapter>
    </HashRouter>
  );
}

export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <TelescopeProvider>
        <QueryClientProvider client={queryClient}>
          <AccessGate>
            <Dashboard />
          </AccessGate>
        </QueryClientProvider>
      </TelescopeProvider>
    </ThemeProvider>
  );
}
