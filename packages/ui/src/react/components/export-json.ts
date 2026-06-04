/**
 * Pure JSON-export helpers shared by the entry-detail and trace export toolbars.
 * Kept framework-free (no React) so they can be unit-tested in isolation.
 */

/** Pretty-print any value with 2-space indent, falling back to String() if not serializable. */
export function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Copy a value as pretty JSON to the clipboard. Resolves to `true` on success,
 * `false` when the Clipboard API is unavailable (or the write rejects) — never throws.
 */
export async function copyJson(value: unknown): Promise<boolean> {
  const text = toPrettyJson(value);
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Trigger a browser download of a value serialized as pretty JSON under `filename`. */
export function downloadJson(filename: string, value: unknown): void {
  const text = toPrettyJson(value);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
