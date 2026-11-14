import { useNavigate, useParams } from 'react-router-dom';
import { PageBody } from '../../aviary-kit/shell/app-shell';
import { EntryDetail, useEntry } from '../../react/index.js';
import { BlockSkeleton } from '../page-chrome.js';

export function EntryPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useEntry(id);
  return (
    <PageBody>
      <button
        type="button"
        onClick={() => navigate('/entries')}
        className="self-start text-xs text-dim hover:text-fg"
      >
        ← Entries
      </button>
      {isLoading || !data ? (
        <BlockSkeleton height={360} />
      ) : (
        <EntryDetail entry={data} onSelect={(entryId) => navigate(`/entries/view/${entryId}`)} />
      )}
    </PageBody>
  );
}
