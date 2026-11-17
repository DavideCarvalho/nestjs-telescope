import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { WINDOWS, type WindowLabel } from '../react/components/window-select.js';

/**
 * The console's view state in the URL (`#/<page>?<query>`, through the kit's `NuqsHashAdapter`):
 * helpers for the params several pages share. Every param drops out of the URL at its default, so
 * a page opened from a plain `#/<page>` link looks exactly as before.
 */

/**
 * The trailing time window, kept in `?window=` (`15m` … `24h`). Picking a window adds a history
 * entry, so Back returns to the previous one. An unknown value falls back to the default.
 */
export function useWindowParam(
  defaultWindow: WindowLabel = '1h',
): [WindowLabel, (next: string) => void] {
  const [window, setWindow] = useQueryState(
    'window',
    parseAsStringLiteral(WINDOWS).withDefault(defaultWindow).withOptions({ history: 'push' }),
  );
  const set = (next: string) => {
    const match = WINDOWS.find((w) => w === next);
    if (match) void setWindow(match);
  };
  return [window, set];
}

/** A free-text param (`?q=`, `?tag=` …); empty is the default, so it leaves the URL. */
export const textParam = parseAsString.withDefault('');
