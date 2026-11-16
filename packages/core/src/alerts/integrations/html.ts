// packages/core/src/alerts/integrations/html.ts
/**
 * Escape text for HTML element content and double-quoted attribute values
 * (Telegram HTML messages, email bodies). `&` first so entities aren't doubled.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
