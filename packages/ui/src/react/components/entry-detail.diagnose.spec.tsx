import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CachedDiagnosis,
  DiagnoseResult,
  EntryWithBatch,
  TelescopeClient,
  TelescopeMeta,
} from '../../client/index.js';
import { TelescopeProvider } from '../telescope-context.js';
import { EntryDetail } from './entry-detail.js';

function mockClient(
  meta: TelescopeMeta,
  diagnose: (id: string, force?: boolean) => Promise<DiagnoseResult>,
  cachedDiagnosis: (id: string) => Promise<CachedDiagnosis> = async () => null,
) {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
    entry: async () => {
      throw new Error('not used');
    },
    meta: async () => meta,
    diagnose,
    cachedDiagnosis,
  } as unknown as TelescopeClient;
}

function exceptionEntry(): EntryWithBatch {
  return {
    id: 'ex1',
    batchId: 'b',
    type: 'exception',
    familyHash: 'fam-A',
    content: { class: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at a' },
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: '2026-06-03T12:00:00Z',
    batch: [],
  };
}

function meta(aiEnabled: boolean): TelescopeMeta {
  return {
    enabled: true,
    droppedCount: 0,
    watchers: [],
    traceLink: null,
    retention: null,
    pruneEnabled: false,
    explainEnabled: false,
    sampling: {},
    auth: { enabled: false, modes: [] },
    ai: { enabled: aiEnabled, mode: 'on-demand' },
  };
}

function renderDetail(
  aiEnabled: boolean,
  diagnose: (id: string, force?: boolean) => Promise<DiagnoseResult>,
  cachedDiagnosis: (id: string) => Promise<CachedDiagnosis> = async () => null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <TelescopeProvider client={mockClient(meta(aiEnabled), diagnose, cachedDiagnosis)}>
      <QueryClientProvider client={queryClient}>
        <EntryDetail entry={exceptionEntry()} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('EntryDetail AI diagnosis', () => {
  it('hides the Diagnose button when AI is not enabled', async () => {
    renderDetail(false, async () => ({ ok: true, markdown: 'x', cached: false }));
    await screen.findByText('boom', { exact: false });
    expect(screen.queryByRole('button', { name: 'Diagnose with AI' })).toBeNull();
  });

  it('shows the Diagnose button when AI is enabled', async () => {
    renderDetail(true, async () => ({ ok: true, markdown: 'x', cached: false }));
    expect(await screen.findByRole('button', { name: 'Diagnose with AI' })).toBeTruthy();
  });

  it('renders the markdown after clicking Diagnose', async () => {
    const diagnose = vi.fn(async () => ({
      ok: true as const,
      markdown: '## Probable root cause\nA null deref.',
      cached: false,
    }));
    renderDetail(true, diagnose);
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnose with AI' }));
    await waitFor(() => {
      expect(screen.getByText('Probable root cause')).toBeTruthy();
    });
    expect(diagnose).toHaveBeenCalledWith('ex1', false);
    expect(screen.getByText('A null deref.')).toBeTruthy();
  });

  it('shows a cached badge and a Re-run (force) action for a cached result', async () => {
    const diagnose = vi.fn(async (_id: string, force?: boolean) => ({
      ok: true as const,
      markdown: '## Probable root cause\nCached.',
      cached: force !== true,
    }));
    renderDetail(true, diagnose);
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnose with AI' }));
    await waitFor(() => expect(screen.getByText('cached')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    await waitFor(() => expect(diagnose).toHaveBeenLastCalledWith('ex1', true));
  });

  it('renders the error message when diagnosis fails', async () => {
    renderDetail(true, async () => ({ ok: false, message: 'AI diagnosis failed.' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnose with AI' }));
    await waitFor(() => expect(screen.getByText('AI diagnosis failed.')).toBeTruthy());
  });

  it('renders a cached diagnosis on mount WITHOUT clicking (auto-mode result)', async () => {
    // The mount-fetch resolves with a cached diagnosis (e.g. auto-mode populated
    // it at first-seen). The markdown must appear with the cached badge + Re-run,
    // and the on-demand POST must NOT have been called.
    const diagnose = vi.fn(async () => ({ ok: true as const, markdown: 'x', cached: false }));
    const cachedDiagnosis = vi.fn(async () => ({
      markdown: '## Probable root cause\nAuto-diagnosed.',
      cached: true as const,
    }));
    renderDetail(true, diagnose, cachedDiagnosis);
    await screen.findByText('Auto-diagnosed.');
    expect(screen.getByText('Probable root cause')).toBeTruthy();
    expect(screen.getByText('cached')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeTruthy();
    expect(cachedDiagnosis).toHaveBeenCalledWith('ex1');
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('shows the Diagnose button when nothing is cached on mount', async () => {
    const diagnose = vi.fn(async () => ({ ok: true as const, markdown: 'x', cached: false }));
    const cachedDiagnosis = vi.fn(async () => null);
    renderDetail(true, diagnose, cachedDiagnosis);
    expect(await screen.findByRole('button', { name: 'Diagnose with AI' })).toBeTruthy();
    expect(diagnose).not.toHaveBeenCalled();
    expect(cachedDiagnosis).toHaveBeenCalledWith('ex1');
  });

  it('does not fetch the cached diagnosis when AI is disabled', async () => {
    const cachedDiagnosis = vi.fn(async () => null);
    renderDetail(false, async () => ({ ok: true, markdown: 'x', cached: false }), cachedDiagnosis);
    await screen.findByText('boom', { exact: false });
    expect(cachedDiagnosis).not.toHaveBeenCalled();
  });
});
