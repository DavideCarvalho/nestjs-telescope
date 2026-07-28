import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve a relative TS import specifier (written with a `.js` extension) to a source file. */
function resolveLocal(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`Could not resolve "${specifier}" from ${fromFile}`);
}

/** Every bare (node_modules) specifier reachable from `entry`, following relative imports only. */
function externalDeps(entry: string): Set<string> {
  const external = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolveLocal(file, specifier));
      } else {
        external.add(specifier);
      }
    }
  }

  return external;
}

/**
 * The `./react/console` subpath exists so a host can take the launcher WITHOUT the dashboard
 * component set. That promise is only worth anything if it keeps holding.
 *
 * It broke a downstream build once: the host imported the launcher from the `./react` barrel, and
 * the bundler resolved `entry-insights.js` -> `react-router-dom` (a package this one does not
 * declare) even though nothing referenced it. Re-exported modules are resolved, not tree-shaken
 * away, so one stray import in this subpath's graph is a hard build failure for every host that
 * only wanted a button.
 */
describe('./react/console subpath', () => {
  it('depends on nothing but react', () => {
    expect([...externalDeps(resolve(HERE, 'console.ts'))].sort()).toEqual(['react']);
  });

  it('does not reach the dashboard component set', () => {
    // Named explicitly because these two are the undeclared ones — the failure is not "extra
    // bytes", it is the host's bundler failing to resolve a package that was never installed.
    const deps = externalDeps(resolve(HERE, 'console.ts'));
    expect(deps.has('recharts')).toBe(false);
    expect(deps.has('react-router-dom')).toBe(false);
  });

  it('proves the guard works by catching the barrel it is an alternative to', () => {
    // If this ever comes back empty the walker is broken and the assertions above are vacuous.
    const barrel = externalDeps(resolve(HERE, 'index.ts'));
    expect(barrel.has('recharts')).toBe(true);
    expect(barrel.has('react-router-dom')).toBe(true);
  });
});
