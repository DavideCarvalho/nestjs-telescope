import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/index.js';

/** The windows the select offers, shortest first. */
export const WINDOWS = ['15m', '1h', '6h', '24h'] as const;
export type WindowLabel = (typeof WINDOWS)[number];

export function WindowSelect({
  value,
  onChange,
}: { value: string; onChange: (w: string) => void }): React.JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(next);
      }}
    >
      <SelectTrigger aria-label="Time window">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {WINDOWS.map((w) => (
          <SelectItem key={w} value={w}>
            {w}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
