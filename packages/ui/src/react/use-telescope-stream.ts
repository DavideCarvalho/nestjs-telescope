import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTelescopeClient } from './telescope-context.js';

export type StreamStatus = 'connecting' | 'live' | 'polling';

/**
 * Subscribes to the telescope SSE stream and invalidates dashboard queries on each
 * tick, so panels re-resolve the instant new entries land. Falls back to the
 * existing polling (status 'polling') if SSE can't connect or is unavailable (SSR).
 */
export function useTelescopeStream(): { status: StreamStatus } {
  const queryClient = useQueryClient();
  const client = useTelescopeClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setStatus('polling');
      return;
    }
    const streamUrl = `${client.baseUrl}/stream`;
    const es = new EventSource(streamUrl);
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus('polling');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { types?: string[]; heartbeat?: true };
        if (msg.heartbeat) return;
        if (msg.types && msg.types.length > 0) {
          queryClient.invalidateQueries({ queryKey: ['telescope', 'ext-data'] });
          queryClient.invalidateQueries({ queryKey: ['telescope', 'meta'] });
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [queryClient, client.baseUrl]);

  return { status };
}
