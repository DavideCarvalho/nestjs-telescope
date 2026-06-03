import { useNavigate, useParams } from 'react-router-dom';
import { EntriesTable, isKnownType, useEntries } from '../../react/index.js';

export function EntriesPage(): JSX.Element {
  const { type: routeType } = useParams();
  const navigate = useNavigate();
  const activeType = routeType && isKnownType(routeType) ? routeType : undefined;
  const { data, isLoading } = useEntries(activeType ? { type: activeType } : {});
  return (
    <div className="p-4">
      {isLoading ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <EntriesTable
          entries={data?.data ?? []}
          onSelect={(id) => navigate(`/entries/view/${id}`)}
        />
      )}
    </div>
  );
}
