import { useNavigate, useParams } from 'react-router-dom';
import { EntryDetail, useEntry } from '../../react/index.js';

export function EntryPage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useEntry(id);
  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => navigate('/entries')}
        className="mb-4 text-xs text-muted-foreground hover:text-foreground"
      >
        ← entries
      </button>
      {isLoading || !data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <EntryDetail entry={data} onSelect={(entryId) => navigate(`/entries/view/${entryId}`)} />
      )}
    </div>
  );
}
