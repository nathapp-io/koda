/**
 * Build guard: fail when a DI-relevant package is installed more than once.
 *
 * The production image installs runtime deps with its own `bun install --production`,
 * which resolves `~` ranges fresh at build time. A package that pins a sibling exactly
 * (nestjs-notify 1.3.1 depends on nestjs-tenant "1.3.1") then gets a nested second copy
 * when koda pins another version. Nest DI tokens are classes, so two copies of a
 * provider class mean "Nest can't resolve dependencies" at boot (#437). That holds for two
 * copies of the SAME version too (nested twice, or two Bun peer hashes), so the guard
 * counts copies on disk, not versions. Fix a hit by aligning koda's version with the
 * one the dependent package requires.
 *
 * Usage: bun scripts/check-runtime-deps.ts [nodeModulesDir]   (default: node_modules)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PackageCopy {
  /** Package directory relative to the scanned node_modules. */
  path: string;
  version: string;
}

export interface DuplicatePackage {
  name: string;
  copies: PackageCopy[];
}

/** Packages whose classes are Nest DI tokens: @nathapp/*, @nestjs/* and unscoped nestjs-* (nestjs-i18n). */
export function isDiRelevant(name: string): boolean {
  return name.startsWith('@nathapp/') || name.startsWith('@nestjs/') || name.startsWith('nestjs-');
}

interface InstalledPackage {
  name: string;
  version: string;
  dir: string;
}

function parsePackageJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`check-runtime-deps: cannot parse ${file}: ${(error as Error).message}`);
  }
}

function readPackage(pkgDir: string): InstalledPackage | null {
  const file = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(file)) return null;
  const { name, version } = parsePackageJson(file);
  return typeof name === 'string' && typeof version === 'string' ? { name, version, dir: pkgDir } : null;
}

function packageDirs(nodeModulesDir: string): string[] {
  return fs.readdirSync(nodeModulesDir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(nodeModulesDir, entry.name);
    if (!entry.isDirectory()) return []; // symlinks (isolated-store links, .bin) are not followed
    if (entry.name === '.bun') {
      return fs
        .readdirSync(full, { withFileTypes: true })
        .filter((storeEntry) => storeEntry.isDirectory())
        .flatMap((storeEntry) => listNested(path.join(full, storeEntry.name)));
    }
    if (entry.name.startsWith('.')) return [];
    if (entry.name.startsWith('@')) {
      return fs
        .readdirSync(full, { withFileTypes: true })
        .filter((scoped) => scoped.isDirectory())
        .map((scoped) => path.join(full, scoped.name));
    }
    return [full];
  });
}

function listNested(dir: string): string[] {
  const nested = path.join(dir, 'node_modules');
  return fs.existsSync(nested) ? collect(nested) : [];
}

function collect(nodeModulesDir: string): string[] {
  return packageDirs(nodeModulesDir).flatMap((pkgDir) => [pkgDir, ...listNested(pkgDir)]);
}

export function findDuplicatePackages(nodeModulesDir: string): DuplicatePackage[] {
  const installed = collect(nodeModulesDir)
    .map(readPackage)
    .filter((pkg): pkg is InstalledPackage => pkg !== null && isDiRelevant(pkg.name));

  const names = [...new Set(installed.map((pkg) => pkg.name))].sort((a, b) => a.localeCompare(b));

  return names
    .map((name) => ({
      name,
      copies: installed
        .filter((pkg) => pkg.name === name)
        .map((pkg) => ({ path: path.relative(nodeModulesDir, pkg.dir), version: pkg.version }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .filter((dup) => dup.copies.length > 1);
}

function main(): void {
  const nodeModulesDir = path.resolve(process.argv[2] ?? 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    process.stderr.write(`check-runtime-deps: ${nodeModulesDir} does not exist\n`);
    process.exit(1);
  }

  const duplicates = findDuplicatePackages(nodeModulesDir);
  if (duplicates.length > 0) {
    const lines = duplicates
      .map((dup) => `  ${dup.name}\n${dup.copies.map((copy) => `    ${copy.version}  ${copy.path}`).join('\n')}`)
      .join('\n');
    process.stderr.write(
      `check-runtime-deps: packages installed more than once (Nest DI breaks at boot):\n${lines}\n` +
        'Align the version in apps/api/package.json with the one the dependent package requires.\n',
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
