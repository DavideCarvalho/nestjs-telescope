import { createContext, useContext, useMemo, useState } from 'react';
import { type TelescopeClient, createTelescopeClient } from '../client/index.js';

const TelescopeContext = createContext<TelescopeClient | null>(null);

interface LiveTailValue {
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

const LiveTailContext = createContext<LiveTailValue | null>(null);

export function TelescopeProvider({
  client,
  children,
}: { client?: TelescopeClient; children: React.ReactNode }): JSX.Element {
  const value = client ?? createTelescopeClient();
  const [paused, setPaused] = useState(false);
  const liveTail = useMemo<LiveTailValue>(() => ({ paused, setPaused }), [paused]);
  return (
    <TelescopeContext.Provider value={value}>
      <LiveTailContext.Provider value={liveTail}>{children}</LiveTailContext.Provider>
    </TelescopeContext.Provider>
  );
}

export function useTelescopeClient(): TelescopeClient {
  const client = useContext(TelescopeContext);
  if (!client) throw new Error('useTelescopeClient must be used within a TelescopeProvider');
  return client;
}

export function useLiveTail(): LiveTailValue {
  const liveTail = useContext(LiveTailContext);
  if (!liveTail) throw new Error('useLiveTail must be used within a TelescopeProvider');
  return liveTail;
}

export function usePaused(): boolean {
  return useLiveTail().paused;
}
