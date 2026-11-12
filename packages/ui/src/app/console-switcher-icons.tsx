import type { ReactNode } from 'react';

/** The icon keys a console can register. Anything else renders as `generic`. */
export type ConsoleIconKey =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

/** The switcher's console icons: 24×24 stroke glyphs in currentColor, the same set in every console. */
const PATHS: Record<ConsoleIconKey, ReactNode> = {
  workflow: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h4a2 2 0 0 1 2 2v5" />
    </>
  ),
  telescope: (
    <>
      <path d="m4 14 13-6 2 4-13 6z" />
      <path d="m10 16 2 5M14 15l-2 6M17 8l1-3 3 1-1 3" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  payments: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6.5 15h4" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 8V4M9 13h.01M15 13h.01M9.5 16.5h5" />
      <circle cx="12" cy="3.5" r="0.5" />
    </>
  ),
  identity: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8 16a4.5 4.5 0 0 1 8 0" />
    </>
  ),
  generic: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
};

/** `value` when it is a known icon key, otherwise `generic`. */
export function iconKey(value: unknown): ConsoleIconKey {
  return typeof value === 'string' && Object.hasOwn(PATHS, value)
    ? (value as ConsoleIconKey)
    : 'generic';
}

export function ConsoleIcon({ icon, className }: { icon: string; className?: string }) {
  const key = iconKey(icon);
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      data-icon={key}
    >
      {PATHS[key]}
    </svg>
  );
}
