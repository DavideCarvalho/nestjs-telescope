// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  joinHash,
  notifyHashUrl,
  readHashSearch,
  splitHash,
  subscribeHashUrl,
  writeHashSearch,
} from './hash-url';
import { NuqsHashAdapter } from './nuqs-hash-adapter';

/** Point jsdom at `url` without a navigation (and without firing `hashchange`). */
function goTo(url: string) {
  window.history.replaceState(null, '', url);
}

/** A test DOM may not fire `hashchange` when a test writes `location.hash`; a browser does. */
function setHash(hash: string) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

afterEach(() => {
  cleanup();
  goTo('/');
});

describe('splitHash / joinHash', () => {
  it('splits the route path from the query on the first `?`', () => {
    expect(splitHash('#/entries?type=query&q=a?b')).toEqual({
      path: '/entries',
      search: 'type=query&q=a?b',
    });
    expect(splitHash('#/entries')).toEqual({ path: '/entries', search: '' });
    expect(splitHash('')).toEqual({ path: '', search: '' });
  });

  it('joins without a dangling `?`', () => {
    expect(joinHash('/entries', '?type=query')).toBe('#/entries?type=query');
    expect(joinHash('/entries', 'type=query')).toBe('#/entries?type=query');
    expect(joinHash('/entries', '')).toBe('#/entries');
  });
});

describe('writeHashSearch', () => {
  it('keeps the route path and the page query, and notifies subscribers', () => {
    goTo('/console?app=shop#/entries');
    let calls = 0;
    const off = subscribeHashUrl(() => calls++);
    writeHashSearch('?type=query');
    off();
    expect(window.location.pathname).toBe('/console');
    expect(window.location.search).toBe('?app=shop');
    expect(window.location.hash).toBe('#/entries?type=query');
    expect(readHashSearch().get('type')).toBe('query');
    expect(calls).toBe(1);
  });

  it('push adds a history entry, replace does not', () => {
    goTo('/#/entries');
    const start = window.history.length;
    writeHashSearch('?a=1', 'replace');
    expect(window.history.length).toBe(start);
    writeHashSearch('?a=2', 'push');
    expect(window.history.length).toBe(start + 1);
  });

  it('is a no-op when nothing changes', () => {
    goTo('/#/entries?a=1');
    let calls = 0;
    const off = subscribeHashUrl(() => calls++);
    writeHashSearch('?a=1');
    off();
    expect(calls).toBe(0);
  });
});

function Probe() {
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [page, setPage] = useQueryState(
    'page',
    parseAsInteger.withDefault(1).withOptions({ history: 'push' }),
  );
  return (
    <div>
      <output data-testid="q">{q}</output>
      <output data-testid="page">{page}</output>
      <input aria-label="q" value={q} onChange={(e) => void setQ(e.target.value)} />
      <button type="button" onClick={() => void setPage((p) => p + 1)}>
        next
      </button>
      <button type="button" onClick={() => void setPage(1)}>
        first
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <StrictMode>
      <NuqsHashAdapter>
        <Probe />
      </NuqsHashAdapter>
    </StrictMode>,
  );
}

describe('NuqsHashAdapter', () => {
  it('reads the initial state from the hash query', () => {
    goTo('/#/entries?q=users&page=3');
    renderProbe();
    expect(screen.getByTestId('q').textContent).toBe('users');
    expect(screen.getByTestId('page').textContent).toBe('3');
  });

  it('writes into the hash, keeping the route path and the page query', async () => {
    goTo('/console?tenant=acme#/entries');
    renderProbe();
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'orders' } });
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=orders'));
    expect(window.location.pathname).toBe('/console');
    expect(window.location.search).toBe('?tenant=acme');
  });

  it('drops a param set back to its default (clearOnDefault)', async () => {
    goTo('/#/entries?page=2');
    renderProbe();
    fireEvent.click(screen.getByText('first'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries'));
    expect(screen.getByTestId('page').textContent).toBe('1');
  });

  it('typing replaces the history entry; an explicit push adds one', async () => {
    goTo('/#/entries');
    renderProbe();
    const start = window.history.length;
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'a' } });
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=a'));
    expect(window.history.length).toBe(start);
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=a&page=2'));
    expect(window.history.length).toBe(start + 1);
  });

  it('follows a hash written elsewhere (a link, the router)', async () => {
    goTo('/#/entries');
    renderProbe();
    act(() => setHash('#/entries?q=from-link'));
    await waitFor(() => expect(screen.getByTestId('q').textContent).toBe('from-link'));
  });

  it('follows a router that pushes history itself, once it calls notifyHashUrl', async () => {
    goTo('/#/entries');
    renderProbe();
    // react-router's HashRouter navigates with `history.pushState`, which fires no event.
    act(() => {
      window.history.pushState(null, '', '/#/entries/query?q=pushed');
      notifyHashUrl();
    });
    await waitFor(() => expect(screen.getByTestId('q').textContent).toBe('pushed'));
  });

  it('follows back and forward', async () => {
    goTo('/#/entries');
    renderProbe();
    // Wait for each URL write: nuqs batches updates made within one flush into one history entry.
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries?page=2'));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries?page=3'));

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('2'));
    expect(window.location.hash).toBe('#/entries?page=2');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('1'));
    expect(window.location.hash).toBe('#/entries');

    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('2'));
  });
});
