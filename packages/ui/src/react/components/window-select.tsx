const WINDOWS = ['15m', '1h', '6h', '24h'] as const;

export function WindowSelect({
  value,
  onChange,
}: { value: string; onChange: (w: string) => void }): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
    >
      {WINDOWS.map((w) => (
        <option key={w} value={w}>
          {w}
        </option>
      ))}
    </select>
  );
}
