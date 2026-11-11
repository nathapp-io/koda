/**
 * Build guard: fail when a DI-relevant package is installed at more than one version.
 *
 * The production image installs runtime deps with its own `bun install --production`,
 * which resolves `~` ranges fresh at build time. A package that pins a sibling exactly
 * (nestjs-notify 1.3.1 depends on nestjs-tenant "1.3.1") then gets a nested second copy
 * when koda pins another version. Nest DI tokens are classes, so two copies of a
 * provider class mean "Nest can't resolve dependencies" at boot (#437). Fix a hit by
 * aligning koda's version with the one the dependent package requires.
 *
 * Usage: bun scripts/check-runtime-deps.ts [nodeModulesDir]   (default: node_modules)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DuplicatePackage {
  name: string;
  versions: string[];
}

const DI_SCOPES = ['@nathapp/', '@nestjs/'];

interface InstalledPackage {
  name: string;
  version: string;
}

function readPackage(pkgDir: string): InstalledPackage | null {
  const file = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(file)) return null;
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InstalledPackage>;
  return json.name && json.version ? { name: json.name, version: json.version } : null;
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

export function findDuplicateVersions(nodeModulesDir: string): DuplicatePackage[] {
  const installed = collect(nodeModulesDir)
    .map(readPackage)
    .filter((pkg): pkg is InstalledPackage => pkg !== null)
    .filter((pkg) => DI_SCOPES.some((scope) => pkg.name.startsWith(scope)));

  const versionsByName = installed.reduce<ReadonlyMap<string, ReadonlySet<string>>>(
    (acc, pkg) => new Map(acc).set(pkg.name, new Set([...(acc.get(pkg.name) ?? []), pkg.version])),
    new Map(),
  );

  return [...versionsByName.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function main(): void {
  const nodeModulesDir = path.resolve(process.argv[2] ?? 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    process.stderr.write(`check-runtime-deps: ${nodeModulesDir} does not exist\n`);
    process.exit(1);
  }

  const duplicates = findDuplicateVersions(nodeModulesDir);
  if (duplicates.length > 0) {
    const lines = duplicates.map((dup) => `  ${dup.name}: ${dup.versions.join(', ')}`).join('\n');
    process.stderr.write(
      `check-runtime-deps: packages installed at more than one version (Nest DI breaks at boot):\n${lines}\n` +
        'Align the version in apps/api/package.json with the one the dependent package requires.\n',
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
