import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AiRunRow, AiUsageReport } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { AiPage, formatMs, formatUsd } from './ai-page.js';

const run: AiRunRow = {
  entryId: 'entry-1',
  traceId: 'trace-abc',
  at: new Date().toISOString(),
  status: 'completed',
  agent: 'tutor',
  runId: 'run-1',
  threadId: 't',
  modelId: 'claude-sonnet',
  durationMs: 4200,
  ttftMs: 600,
  queueMs: 40,
  modelMs: 3100,
  toolsMs: 900,
  steps: 2,
  modelCalls: 2,
  toolCalls: 1,
  inputTokens: 1000,
  outputTokens: 200,
  costUsd: 0.0123,
  code: null,
  stepTimings: [
    { step: 0, modelMs: 1800, toolsMs: 900, tools: [{ toolName: 'search_library', ms: 900 }] },
    { step: 1, modelMs: 1300, toolsMs: 0, tools: [] },
  ],
};

function report(over: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    windowStart: new Date(Date.now() - 3_600_000).toISOString(),
    windowEnd: new Date().toISOString(),
    spend: {
      totalUsd: 1.5,
      platformUsd: 0.5,
      estimatedUsd: 0.3,
      calls: 12,
      unpricedCalls: 2,
      inputTokens: 5000,
      outputTokens: 900,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      audioSeconds: 0,
      byFeature: [
        {
          key: 'agent:tutor',
          costUsd: 1,
          calls: 8,
          unpricedCalls: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      ],
      byModel: [
        {
          key: 'claude-sonnet',
          costUsd: 1.5,
          calls: 10,
          unpricedCalls: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      ],
      byActor: [
        {
          key: '@platform',
          costUsd: 0.5,
          calls: 2,
          unpricedCalls: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      ],
      buckets: [
        {
          start: new Date().toISOString(),
          costUsd: 1.5,
          platformUsd: 0.5,
          estimatedUsd: 0.3,
          calls: 12,
        },
      ],
    },
    runs: [run],
    slowest: [run],
    mostExpensive: [run],
    unpriced: [
      {
        feature: 'transcribe',
        model: 'whisper-1',
        provider: 'openai',
        calls: 2,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 90,
        characters: 0,
        lastAt: new Date().toISOString(),
      },
    ],
    coverage: {
      usageEvents: 12,
      runEvents: 1,
      agentEvents: 20,
      legacyAgentLib: false,
      runsWithoutTimings: 0,
    },
    scanned: 33,
    truncated: false,
    ...over,
  };
}

function renderPage(data: AiUsageReport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = mockTelescopeClient({ ai: async () => data });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ai']}>
          <AiPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('AiPage', () => {
  it('shows spend, runs and unpriced calls', async () => {
    renderPage(report());
    expect(await screen.findByText('Total spend')).toBeTruthy();
    expect(screen.getAllByText('$1.50').length).toBeGreaterThan(0);
    expect(screen.getByText('Platform share')).toBeTruthy();
    expect(screen.getByText('33%')).toBeTruthy();
    expect(screen.getByText('Platform (@platform)')).toBeTruthy();
    expect(screen.getByText('Recent runs')).toBeTruthy();
    expect(screen.getByText('whisper-1')).toBeTruthy();
  });

  it('opens a run with its per-step breakdown and a trace link', async () => {
    renderPage(report());
    const cells = await screen.findAllByText('tutor');
    const row = cells.map((c) => c.closest('tr')).find((r) => r !== null);
    fireEvent.click(row as HTMLElement);
    expect(await screen.findByText('Open trace waterfall →')).toBeTruthy();
    expect(screen.getByText('search_library 900ms')).toBeTruthy();
    const link = screen.getByText('Open trace waterfall →').closest('a');
    expect(link?.getAttribute('href')).toBe('/traces/trace-abc');
  });

  it('says the agent lib is too old when agent events exist without usage.recorded', async () => {
    renderPage(
      report({
        runs: [],
        slowest: [],
        mostExpensive: [],
        unpriced: [],
        coverage: {
          usageEvents: 0,
          runEvents: 0,
          agentEvents: 7,
          legacyAgentLib: true,
          runsWithoutTimings: 0,
        },
      }),
    );
    expect(await screen.findByText(/older than/)).toBeTruthy();
    expect(screen.getByText(/No AI spend recorded/)).toBeTruthy();
  });

  it('shows a plain empty state when nothing happened', async () => {
    renderPage(
      report({
        runs: [],
        slowest: [],
        mostExpensive: [],
        unpriced: [],
        coverage: {
          usageEvents: 0,
          runEvents: 0,
          agentEvents: 0,
          legacyAgentLib: false,
          runsWithoutTimings: 0,
        },
      }),
    );
    expect(await screen.findByText('No AI usage or agent runs in this window.')).toBeTruthy();
  });
});

describe('formatters', () => {
  it('keeps the digits that matter', () => {
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(null)).toBe('—');
    expect(formatMs(850)).toBe('850ms');
    expect(formatMs(4200)).toBe('4.20s');
    expect(formatMs(125_000)).toBe('2m 5s');
  });
});
