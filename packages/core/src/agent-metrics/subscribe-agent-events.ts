// packages/core/src/agent-metrics/subscribe-agent-events.ts
import diagnostics_channel from 'node:diagnostics_channel';
import {
  AGENT_CHANNEL_PREFIX,
  AGENT_METRIC_EVENTS,
  type AgentObservation,
  readAgentEvent,
} from './agent-events.js';

/** A consumer of agent observations. A throw is swallowed — it never reaches the agent loop. */
export type AgentObservationListener = (observation: AgentObservation) => void;

/**
 * Subscribe to the agent's `usage.recorded` and terminal run channels DIRECTLY on
 * `node:diagnostics_channel` and hand each event, parsed, to `listener`.
 *
 * Direct, and not through recorded Telescope entries, on purpose: entries are sampled, pruned and
 * may be recorded by either of two watchers (or neither). A metric must count every event exactly
 * once, so it reads the source. Subscribing is also what makes `emit()` publish at all
 * (`channel.hasSubscribers`), so this works with no Telescope watcher installed.
 *
 * Returns the unsubscribe function.
 */
export function subscribeAgentObservations(listener: AgentObservationListener): () => void {
  const handlers: [string, (message: unknown) => void][] = [];
  for (const event of AGENT_METRIC_EVENTS) {
    const name = `${AGENT_CHANNEL_PREFIX}${event}`;
    const handler = (message: unknown): void => {
      try {
        const envelope = message as { event?: unknown; payload?: unknown } | null;
        const observation = readAgentEvent(event, envelope?.payload);
        if (observation !== null) listener(observation);
      } catch {
        // Observability must never break the agent run that published the event.
      }
    };
    diagnostics_channel.subscribe(name, handler);
    handlers.push([name, handler]);
  }
  return () => {
    for (const [name, handler] of handlers) diagnostics_channel.unsubscribe(name, handler);
  };
}
