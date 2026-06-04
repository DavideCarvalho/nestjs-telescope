import { useState } from 'react';
import { copyJson, downloadJson } from './export-json.js';

const BUTTON_CLASS =
  'rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 ' +
  'transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100';

/**
 * A small toolbar exposing "Copy JSON" / "Download JSON" actions for a value.
 * Used on the entry-detail page to export the full `EntryWithBatch`.
 */
export function ExportJsonToolbar({
  value,
  filename,
}: { value: unknown; filename: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    const ok = await copyJson(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={handleCopy} className={BUTTON_CLASS}>
        {copied ? 'Copied' : 'Copy JSON'}
      </button>
      <button type="button" onClick={() => downloadJson(filename, value)} className={BUTTON_CLASS}>
        Download JSON
      </button>
    </div>
  );
}
