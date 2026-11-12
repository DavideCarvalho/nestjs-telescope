#!/usr/bin/env node
/**
 * Lints every published package the way a consumer would install it: `publint` checks the
 * package.json against the files that ship, and `@arethetypeswrong/cli` resolves the types of
 * every export from the packed tarball. Run after the build.
 *
 * Usage:
 *   node scripts/check-package.mjs            # every non-private package under packages/
 *   node scripts/check-package.mjs <dir>...   # the given package directories
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => join(repoRoot, 'node_modules', '.bin', name);

const args = process.argv.slice(2);
const dirs =
  args.length > 0
    ? args.map((d) => resolve(d))
    : readdirSync(join(repoRoot, 'packages'))
        .map((d) => join(repoRoot, 'packages', d))
        .filter((d) => existsSync(join(d, 'package.json')));

let failed = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.private === true) continue;
  console.log(`\n▸ ${pkg.name}`);
  const out = mkdtempSync(join(tmpdir(), 'check-package-'));
  try {
    execFileSync(bin('publint'), ['run', '--strict', dir], { stdio: 'inherit' });
    // Piped rather than shown: a failing `prepack` hook's output is printed in the catch below.
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'pipe' });
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`pnpm pack wrote no .tgz to ${out}`);
    // Every package here is ESM-only, so the CommonJS resolution modes are not expected to work.
    execFileSync(bin('attw'), [join(out, tarball), '--profile', 'esm-only', '--format', 'table'], {
      stdio: 'inherit',
    });
  } catch (error) {
    // publint and attw print their findings above; this names the package. For a failed
    // `pnpm pack` the message carries its stderr, and its stdout is printed after it.
    console.error(`✗ ${pkg.name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error?.stdout?.length) process.stderr.write(error.stdout);
    failed++;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed the package checks.`);
  process.exit(1);
}
