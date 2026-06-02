import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PulsePanel, WindowSelect, usePulse } from '../../react/index.js';

export function PulsePage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const navigate = useNavigate();
  const { data, isLoading } = usePulse(window);
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Pulse</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      {isLoading || !data ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <PulsePanel report={data} onSelectEntry={(id) => navigate(`/entries/${id}`)} />
      )}
    </div>
  );
}
