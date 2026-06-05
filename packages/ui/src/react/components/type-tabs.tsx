import { visibleTypeTabIds } from './entry-types.js';

export function TypeTabs({
  active,
  onChange,
  watchers,
}: {
  active: string;
  onChange: (type: string) => void;
  /**
   * Registered watcher type strings from `/api/meta.watchers`. When supplied,
   * only the `all` tab plus tabs for registered watchers render; when omitted
   * (meta not loaded / older server), every tab shows — no flash-of-hidden-nav.
   */
  watchers?: readonly string[];
}): JSX.Element {
  const tabs = visibleTypeTabIds(watchers);
  return (
    <div className="flex gap-1 border-b border-zinc-800">
      {tabs.map((type) => (
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
