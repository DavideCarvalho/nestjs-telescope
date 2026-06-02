import { createContext, useContext } from 'react';
import { type TelescopeClient, createTelescopeClient } from '../client/index.js';

const TelescopeContext = createContext<TelescopeClient | null>(null);

export function TelescopeProvider({
  client,
  children,
}: { client?: TelescopeClient; children: React.ReactNode }): JSX.Element {
  const value = client ?? createTelescopeClient();
  return <TelescopeContext.Provider value={value}>{children}</TelescopeContext.Provider>;
}

export function useTelescopeClient(): TelescopeClient {
  const client = useContext(TelescopeContext);
  if (!client) throw new Error('useTelescopeClient must be used within a TelescopeProvider');
  return client;
}
