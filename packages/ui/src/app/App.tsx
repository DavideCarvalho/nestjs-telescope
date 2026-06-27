import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { TelescopeProvider } from '../react/index.js';
import { AuthProvider, useAuth } from './auth-context.js';
import { AuthScreen } from './auth-screen.js';
import { DashboardLayout } from './dashboard-layout.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { QueueManagerPage } from './pages/QueueManagerPage.js';
import { EntriesPage } from './pages/entries-page.js';
import { EntryPage } from './pages/entry-page.js';
import { ExportsPage } from './pages/exports-page.js';
import { ExtensionDashboardPage } from './pages/extension-dashboard-page.js';
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

function Dashboard(): JSX.Element {
  return (
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
          <Route path="/prunes" element={<PrunesPage />} />
          <Route path="/exports" element={<ExportsPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/ext/:dashboardId" element={<ExtensionDashboardPage />} />
        </Routes>
      </DashboardLayout>
    </HashRouter>
  );
}

/**
 * Boot gate: `auth.me()` decides what mounts.
 * - `loading`: a neutral splash while the first `me()` resolves.
 * - `disabled` / `app`: the dashboard (authenticated shows the logout button).
 * - `screen`: the AuthScreen for the offered modes.
 */
function AuthGate(): JSX.Element {
  const { phase, modes } = useAuth();
  if (phase === 'loading') {
    return <div className="min-h-screen bg-zinc-950" data-testid="auth-loading" />;
  }
  if (phase === 'screen') {
    return <AuthScreen modes={modes} />;
  }
  return <Dashboard />;
}

export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <TelescopeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
        </QueryClientProvider>
      </TelescopeProvider>
    </ThemeProvider>
  );
}
