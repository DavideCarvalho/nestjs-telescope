import { useEffect, useState } from 'react';

export function App(): JSX.Element {
  const [meta, setMeta] = useState<unknown>(null);
  useEffect(() => {
    fetch('/telescope/api/meta')
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta({ error: true }));
  }, []);
  return (
    <div className="min-h-screen bg-zinc-950 p-6 font-mono text-sm text-zinc-200">
      <h1 className="text-lg font-semibold text-emerald-400">Telescope</h1>
      <pre className="mt-4 text-zinc-400">{JSON.stringify(meta, null, 2)}</pre>
    </div>
  );
}
