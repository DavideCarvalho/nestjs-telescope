// @vitest-environment node
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The barrel-leak check, run against the PUBLISHED artifact rather than the source tree.
 *
 * `console-subpath.spec.ts` walks TypeScript source and is the fast guard. This one bundles
 * `dist/**` with esbuild and records every bare specifier the bundler actually resolves —
 * which is the thing that broke a host build once. A re-exported module is *resolved* by a
 * bundler even when nothing imports it, so neither a grep nor a source walk over the entry
 * file alone is proof; only following the real graph is.
 *
 * The rule being enforced: every package a published entry can reach must appear in this
 * package's own `dependencies` or `peerDependencies`. A host that installs this package and
 * imports a published entry must never hit an unresolvable import.
 *
 * Skipped when `dist/` is absent (a bare `vitest` run before `build`); CI builds first.
 */

const distDir = fileURLToPath(new URL('../../dist', import.meta.url));
const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const built = existsSync(`${distDir}/react/index.js`);

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function declaredPackages(): Set<string> {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageManifest;
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

/** `@scope/pkg/sub` and `pkg/sub` both belong to their package root. */
function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}

/** Every bare specifier reachable from `entry`, per esbuild's own resolution. */
async function reachablePackages(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  await build({
    entryPoints: [`${distDir}/${entry}`],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'record-bare-specifiers',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return null;
            if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
            // Mark external so resolution never fails: we want the import surface, not a build.
            if (!args.path.startsWith('node:')) seen.add(packageRoot(args.path));
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  return seen;
}

describe.skipIf(!built)('published module graph', () => {
  it('the ./react/console launcher still reaches nothing but react', async () => {
    // The launcher's whole promise: a host that wants only a button installs only react.
    // Adding the vendored shadcn layer is a fresh chance to break it.
    expect([...(await reachablePackages('react/console.js'))].sort()).toEqual(['react']);
  });

  it.each([['react/index.js'], ['react/console.js'], ['server/index.js'], ['client/index.js']])(
    'every package %s reaches is declared',
    async (entry) => {
      const declared = declaredPackages();
      const undeclared = [...(await reachablePackages(entry))].filter(
        (name) => !declared.has(name),
      );
      expect(undeclared.sort()).toEqual([]);
    },
  );
});
