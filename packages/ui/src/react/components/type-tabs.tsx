const TYPES = ['all', 'request', 'query', 'job', 'exception', 'http_client', 'mail'] as const;

export function TypeTabs({
  active,
  onChange,
}: { active: string; onChange: (type: string) => void }): JSX.Element {
  return (
    <div className="flex gap-1 border-b border-zinc-800">
      {TYPES.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => onChange(type)}
          className={`px-3 py-2 text-xs uppercase tracking-wide ${
            active === type
              ? 'border-b-2 border-emerald-400 text-emerald-300'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {type}
        </button>
      ))}
    </div>
  );
}
