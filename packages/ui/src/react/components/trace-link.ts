/**
 * Build a concrete trace URL from a host-configured template by substituting
 * the `{traceId}` / `{spanId}` placeholders. Returns null when no template is set.
 */
export function buildTraceHref(
  template: string | null,
  traceId: string,
  spanId: string,
): string | null {
  if (!template) return null;
  return template.replaceAll('{traceId}', traceId).replaceAll('{spanId}', spanId);
}
