import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_MANIFESTS } from '../../../../../scripts/lib/release-manifests';
import { REPO_ROOT } from './helpers/workflow-steps';

// The published packages release under one version (RELEASING.md). The runner is versioned on its own and is
// deliberately not part of this set: its version is what `koda-runner --version` and sync `daemonVersion` report.
const WORKSPACES = ['apps/api', 'apps/cli', 'apps/web'];

function manifestVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as { version: string }).version;
}

describe('release version lockstep', () => {
  const rootVersion = manifestVersion('.');

  it.each(WORKSPACES)('%s/package.json carries the root version', (dir) => {
    expect(manifestVersion(dir)).toBe(rootVersion);
  });

  it.each(WORKSPACES)('bun.lock records %s at the root version', (dir) => {
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8');
    const escaped = dir.replace(/[/.]/g, '\\$&');
    const match = new RegExp(`"${escaped}": \\{\\s*"name": "[^"]+",\\s*"version": "([^"]+)"`).exec(lock);
    expect(match?.[1]).toBe(rootVersion);
  });

  it('the release command sets exactly the root, api, cli and web manifests, never the runner', () => {
    expect([...RELEASE_MANIFESTS]).toEqual(['package.json', ...WORKSPACES.map((dir) => `${dir}/package.json`)]);
    expect(RELEASE_MANIFESTS).not.toContain('apps/runner/package.json');
  });
});
