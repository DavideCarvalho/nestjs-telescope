import type { ReactNode } from 'react';

/**
 * The @dudousxd/nestjs-* family.
 *
 * This list is intentionally identical across every library's site so the
 * switcher reads the same wherever you land. When a new library ships, add it
 * here and copy this file into its site's `lib/` directory.
 */
export interface NestjsLibrary {
  /** Bare package / repo name, e.g. `nestjs-filter`. */
  name: string;
  /** Published npm package, e.g. `@dudousxd/nestjs-filter`. */
  npm: string;
  /** Deployed docs/landing URL (GitHub Pages project site). */
  url: string;
  /** One-line pitch shown under the name in the dropdown. */
  description: string;
  /** Tailwind background class for the brand dot — matches each site's NavTitle. */
  dot: string;
}

export const nestjsLibraries: NestjsLibrary[] = [
  {
    name: 'nestjs-inertia',
    npm: '@dudousxd/nestjs-inertia',
    url: 'https://davidecarvalho.github.io/nestjs-inertia',
    description: 'Inertia.js for NestJS — build SPAs without writing an API.',
    dot: 'bg-violet-400',
  },
  {
    name: 'nestjs-filter',
    npm: '@dudousxd/nestjs-filter',
    url: 'https://davidecarvalho.github.io/nestjs-filter',
    description: 'Type-safe filtering & querying for NestJS, end to end.',
    dot: 'bg-sky-400',
  },
  {
    name: 'nestjs-codegen',
    npm: '@dudousxd/nestjs-codegen',
    url: 'https://davidecarvalho.github.io/nestjs-codegen',
    description: 'Generate fully-typed clients from your NestJS controllers.',
    dot: 'bg-amber-400',
  },
  {
    name: 'nestjs-telescope',
    npm: '@dudousxd/nestjs-telescope',
    url: 'https://davidecarvalho.github.io/nestjs-telescope',
    description: 'Debug & observability dashboard for NestJS.',
    dot: 'bg-emerald-400',
  },
];

function LibraryDot({ className }: { className: string }): ReactNode {
  return (
    <span
      aria-hidden
      className={`size-2 shrink-0 rounded-full ${className} shadow-[0_0_8px_2px] shadow-current/40`}
    />
  );
}

/**
 * A Fumadocs "menu" nav item that switches between the @dudousxd/nestjs-*
 * libraries. The same `links` array feeds both the landing (HomeLayout) and
 * docs (DocsLayout) navbars, so dropping this in once covers both.
 *
 * Pass the current site's library name to subtly flag "you're here".
 */
export function librarySwitcher(current?: string) {
  return {
    type: 'menu' as const,
    text: 'Libraries',
    items: nestjsLibraries.map((lib) => ({
      text: lib.name,
      description:
        lib.name === current ? `You're here · ${lib.description}` : lib.description,
      url: lib.url,
      external: true,
      icon: <LibraryDot className={lib.dot} />,
    })),
  };
}
