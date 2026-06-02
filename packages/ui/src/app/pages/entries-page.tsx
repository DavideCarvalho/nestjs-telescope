import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EntriesTable, TypeTabs, useEntries } from '../../react/index.js';

export function EntriesPage(): JSX.Element {
  const [type, setType] = useState('all');
  const navigate = useNavigate();
  const { data, isLoading } = useEntries(type === 'all' ? {} : { type });
  return (
    <div>
      <TypeTabs active={type} onChange={setType} />
      <div className="p-4">
        {isLoading ? (
          <p className="text-zinc-600">Loading…</p>
        ) : (
          <EntriesTable entries={data?.data ?? []} onSelect={(id) => navigate(`/entries/${id}`)} />
        )}
      </div>
    </div>
  );
}
