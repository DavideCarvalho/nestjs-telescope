/**
 * The shell fields every Aviary console's JSON data block may carry (`<script type="application/json"
 * id="<console>-config">`), read and validated. Absent or malformed fields read as absent: the shell
 * then hides that piece (no switcher, no ⌘K, no user row, no sign-out). No React, no fetch.
 *
 *   switcher?: { endpoint: string; others: number }       // GET → { consoles: [...] }
 *   search?:   { endpoint: string; self?: string }        // GET ?q= → { results|groups: [...] }
 *              (`self` = this console's registry id: the endpoint also answers `?q=&console=<id>`
 *              for ONE console, so ⌘K can stream each console's hits as they arrive)
 *   viewer?:   { label: string; email?: string; role?: string }
 *   signOut?:  { action: string; csrfToken?: string } | { href: string }
 */

export interface SwitcherConfig {
  endpoint: string;
  others: number;
}

export interface SearchConfig {
  endpoint: string;
  /**
   * aviary: this console's registry id. Present when the endpoint answers `?console=<id>` for one
   * console at a time: ⌘K then asks each console separately and streams the groups in.
   */
  self?: string;
}

const CONSOLE_ID = /^[a-z][a-z0-9-]*$/;

export interface Viewer {
  label: string;
  email?: string;
  role?: string;
}

export type SignOut = { action: string; csrfToken?: string } | { href: string };

export interface AviaryShellConfig {
  switcher?: SwitcherConfig;
  search?: SearchConfig;
  viewer?: Viewer;
  signOut?: SignOut;
}

/** Only same-origin absolute paths are followed: `/x`, never `//host`, a scheme, a backslash or a
 *  control character. */
export function isSafeHref(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Validate the shell fields of an already-parsed data block. */
export function parseShellConfig(raw: unknown): AviaryShellConfig {
  const block = record(raw) ?? {};
  const out: AviaryShellConfig = {};

  const switcher = record(block.switcher);
  if (
    switcher &&
    isSafeHref(switcher.endpoint) &&
    typeof switcher.others === 'number' &&
    switcher.others > 0
  ) {
    out.switcher = { endpoint: switcher.endpoint, others: switcher.others };
  }

  const search = record(block.search);
  if (search && isSafeHref(search.endpoint)) {
    const self = typeof search.self === 'string' && CONSOLE_ID.test(search.self) ? search.self : '';
    out.search = { endpoint: search.endpoint, ...(self ? { self } : {}) };
  }
  // Consoles that predate the `search` field serve it at `<switcher endpoint>/search`.
  else if (out.switcher) out.search = { endpoint: `${out.switcher.endpoint}/search` };

  const viewer = record(block.viewer);
  const label = text(viewer?.label);
  if (viewer && label) {
    const email = text(viewer.email);
    const role = text(viewer.role);
    out.viewer = { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
  }

  const signOut = record(block.signOut);
  if (signOut && isSafeHref(signOut.action)) {
    const csrfToken = text(signOut.csrfToken);
    out.signOut = { action: signOut.action, ...(csrfToken ? { csrfToken } : {}) };
  } else if (signOut && isSafeHref(signOut.href)) {
    out.signOut = { href: signOut.href };
  }
  return out;
}

/** Read the shell fields from the data block `elementId` (`{}` when absent or unreadable). */
export function readShellConfig(elementId: string): AviaryShellConfig {
  if (typeof document === 'undefined') return {};
  const element = document.getElementById(elementId);
  if (element === null) return {};
  try {
    return parseShellConfig(JSON.parse(element.textContent ?? ''));
  } catch {
    return {};
  }
}
