/**
 * release-manifests.ts - the manifests that share koda's release version (RELEASING.md).
 *
 * The runner (`apps/runner`) is versioned on its own and is deliberately not listed: its version is what
 * `koda-runner --version` and the sync `daemonVersion` report, so a repo-wide release must not change it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_MANIFESTS = [
  'package.json',
  'apps/api/package.json',
  'apps/cli/package.json',
  'apps/web/package.json',
] as const;

/** The top-level `"version"` line in a two-space-indented manifest. */
const VERSION_LINE = /^ {2}"version": "[^"]*",?$/m;

function readVersion(root: string, manifest: string): string {
  const parsed = JSON.parse(readFileSync(join(root, manifest), 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`${manifest} has no version`);
  return parsed.version;
}

export function readVersions(root: string): ReadonlyMap<string, string> {
  return new Map(RELEASE_MANIFESTS.map((manifest) => [manifest, readVersion(root, manifest)]));
}

/** The one version every release manifest shares; throws listing each manifest when they disagree. */
export function sharedVersion(versions: ReadonlyMap<string, string>): string {
  const distinct = new Set(versions.values());
  if (distinct.size !== 1) {
    const listing = [...versions].map(([manifest, version]) => `  ${manifest}: ${version}`).join('\n');
    throw new Error(`Release manifests disagree on the version:\n${listing}`);
  }
  return [...distinct][0] ?? '';
}

/**
 * Rewrites only the top-level version line of each manifest, so the diff is one line per file and the
 * formatting is kept. Verifies each file still parses to the new version.
 */
export function writeVersion(root: string, version: string): void {
  for (const manifest of RELEASE_MANIFESTS) {
    const path = join(root, manifest);
    const text = readFileSync(path, 'utf8');
    const line = VERSION_LINE.exec(text)?.[0];
    if (line === undefined) throw new Error(`${manifest}: no top-level "version" line to update`);
    const updated = text.replace(VERSION_LINE, `  "version": "${version}"${line.endsWith(',') ? ',' : ''}`);
    writeFileSync(path, updated);
    if (readVersion(root, manifest) !== version) throw new Error(`${manifest}: version update did not take`);
  }
}
