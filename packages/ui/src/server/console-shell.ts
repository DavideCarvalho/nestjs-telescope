import { isSameOriginPath } from '@dudousxd/nestjs-telescope';

/*
 * The console shell's "who is here" and "how to leave": the `viewer` and `signOut` fields of the
 * page's JSON config block. Everything is read STRUCTURALLY: this package depends on no auth
 * library, no CSRF middleware and no account console.
 */

/** Who is signed in, as the sidebar footer shows it. */
export interface ConsoleViewer {
  /** Main line: a name or an email. */
  label: string;
  email?: string;
  /** Small caps line under it (`admin`). */
  role?: string;
}

/** How the footer signs out: a POST form (with the CSRF token as `_csrf`) or a plain link. */
export type ConsoleSignOut = { action: string; csrfToken?: string } | { href: string };

/**
 * The `viewer` option: the request in, the viewer out (sync or async). `null`/`undefined` (or a
 * throw) means no user row.
 */
export type ConsoleViewerResolver = (
  request: unknown,
) => ConsoleViewer | null | undefined | Promise<ConsoleViewer | null | undefined>;

/**
 * The `signOut` option:
 * - `'/path'`: a POST form to that same-origin path;
 * - `{ href }`: a plain link;
 * - `{ action, csrfToken? }`: a POST form, with `csrfToken(request)` sent as `_csrf`;
 * - `false`: no sign-out, even when an account console announced one.
 */
export type ConsoleSignOutOption =
  | string
  | { href: string }
  | { action: string; csrfToken?: (request: unknown) => string | undefined }
  | false;

/** A same-origin path with no backslash or control character (what the SPA will follow). */
function safePath(path: unknown): path is string {
  return (
    isSameOriginPath(path) &&
    !path.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Read a property without letting a throwing getter escape. */
function read(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A role's name: a string, or an object's `name` / `role`. */
function roleName(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value);
  return text(read(value, 'name')) ?? text(read(value, 'role'));
}

/**
 * A viewer from any user-ish object: `fullName` → `name` → `email` for the label, `email`, and the
 * role from `role`, else the first of `roles` (strings or `{ name }`). `undefined` when nothing
 * usable is there.
 */
export function viewerFromUser(user: unknown): ConsoleViewer | undefined {
  if (typeof user !== 'object' || user === null) return undefined;
  const email = text(read(user, 'email'));
  const label = text(read(user, 'fullName')) ?? text(read(user, 'name')) ?? email;
  if (!label) return undefined;
  const roles = read(user, 'roles');
  const role =
    roleName(read(user, 'role')) ?? (Array.isArray(roles) ? roleName(roles[0]) : undefined);
  return { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
}

/** Keep only the fields the SPA renders, as trimmed non-empty strings. */
function cleanViewer(value: unknown): ConsoleViewer | undefined {
  const label = text(read(value, 'label'));
  if (!label) return undefined;
  const email = text(read(value, 'email'));
  const role = text(read(value, 'role'));
  return { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
}

/**
 * The viewer for this request: the host's `viewer(request)` option when set (a throw or an empty
 * answer means no user row), else a structural read of `request.user` — whatever the host's guards
 * already put there. It never triggers an authentication.
 */
export async function resolveConsoleViewer(
  request: unknown,
  resolver: ConsoleViewerResolver | undefined,
): Promise<ConsoleViewer | undefined> {
  if (resolver) {
    try {
      return cleanViewer(await resolver(request));
    } catch {
      return undefined;
    }
  }
  return viewerFromUser(read(request, 'user'));
}

/** The sign-out an account console announced on the registry (`account.signOut`), read structurally. */
function announcedSignOut(registry: unknown): ConsoleSignOutOption | undefined {
  const signOut = read(read(registry, 'account'), 'signOut');
  if (typeof signOut === 'string') return signOut;
  const action = read(signOut, 'action');
  if (typeof action === 'string') return { action };
  const href = read(signOut, 'href');
  if (typeof href === 'string') return { href };
  return undefined;
}

/** The request's CSRF token, when the host's middleware exposes one (`req.csrfToken()` or a string). */
function requestCsrfToken(request: unknown): string | undefined {
  const token = read(request, 'csrfToken');
  if (typeof token === 'string') return text(token);
  if (typeof token === 'function') {
    try {
      return text((token as () => unknown).call(request));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The sign-out the footer offers: the host's `signOut` option when set (`false` = none), else the
 * one an account console announced on the Aviary consoles registry (`account.signOut`), else none.
 * Only same-origin paths are emitted. A POST action carries a CSRF token when there is one: the
 * option's `csrfToken(request)`, else the request's own (`req.csrfToken()`), read structurally.
 */
export function resolveConsoleSignOut(
  request: unknown,
  configured: ConsoleSignOutOption | undefined,
  registry: unknown,
): ConsoleSignOut | undefined {
  if (configured === false) return undefined;
  const option = configured ?? announcedSignOut(registry);
  if (option === undefined || option === false) return undefined;
  if (typeof option === 'object' && 'href' in option) {
    return safePath(option.href) ? { href: option.href } : undefined;
  }
  const action = typeof option === 'string' ? option : option.action;
  if (!safePath(action)) return undefined;
  let csrfToken: string | undefined;
  if (typeof option === 'object' && typeof option.csrfToken === 'function') {
    try {
      csrfToken = text(option.csrfToken(request));
    } catch {
      csrfToken = undefined;
    }
  } else {
    csrfToken = requestCsrfToken(request);
  }
  return { action, ...(csrfToken ? { csrfToken } : {}) };
}
