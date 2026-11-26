/**
 * release-version.ts - next-version arithmetic for `bun run release` (RELEASING.md).
 *
 * Adapted from nax's `packages/repo-tooling/scripts/lib/release-version.ts`, without the changelog stamping:
 * koda's GitHub Release body is GitHub's generated notes.
 */

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

/** The forms `.github/workflows/release.yml` accepts (its `Set release info` step): X.Y.Z and X.Y.Z-canary.N. */
const RELEASABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-canary\.[1-9]\d*)?$/;

const BUMP_KINDS = ['canary', 'promote', 'patch', 'minor', 'major'] as const;

export function parseVersion(version: string): Version {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`Invalid release version: ${version}`);
  return { major, minor, patch, ...(match[4] ? { prerelease: match[4] } : {}) };
}

function canaryNumber(version: Version): number | undefined {
  const match = /^canary\.([1-9]\d*)$/.exec(version.prerelease ?? '');
  return match ? Number(match[1]) : undefined;
}

/** `kind` is a bump keyword or an explicit version. */
export function bumpVersion(current: string, kind: string): string {
  const v = parseVersion(current);
  const base = `${v.major}.${v.minor}.${v.patch}`;
  const canary = canaryNumber(v);
  switch (kind) {
    case 'canary':
      return canary === undefined ? `${v.major}.${v.minor}.${v.patch + 1}-canary.1` : `${base}-canary.${canary + 1}`;
    case 'promote':
      if (canary === undefined) throw new Error(`Current version ${current} is not a canary`);
      return base;
    case 'patch':
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    case 'minor':
      return `${v.major}.${v.minor + 1}.0`;
    case 'major':
      return `${v.major + 1}.0.0`;
    default:
      parseVersion(kind);
      return kind;
  }
}

/** Semver precedence: -1, 0 or 1. A prerelease sorts below its release; numeric identifiers compare numerically. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === undefined) return 1;
  if (y.prerelease === undefined) return -1;
  return comparePrerelease(x.prerelease, y.prerelease);
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const l = a[i];
    const r = b[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : undefined;
    const rn = /^\d+$/.test(r) ? Number(r) : undefined;
    if (ln !== undefined && rn !== undefined) return ln < rn ? -1 : 1;
    if (ln !== undefined) return -1;
    if (rn !== undefined) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** The next shared version: one the release workflow accepts, and above the current one. */
export function nextReleaseVersion(current: string, kind: string): string {
  const next = bumpVersion(current, kind);
  if (!RELEASABLE.test(next)) throw new Error(`${next} is not releasable: use X.Y.Z or X.Y.Z-canary.N`);
  if (compareVersions(next, current) <= 0) throw new Error(`${next} must be above the current version ${current}`);
  return next;
}

export function isBumpKind(kind: string): boolean {
  return (BUMP_KINDS as readonly string[]).includes(kind);
}

/**
 * What a tag publishes, worded from `.github/workflows/release.yml` (`Compute release channels`). Whether a stable
 * tag also moves `:X.Y`, `:latest` and npm `latest` depends on the tags on origin when the workflow runs.
 */
export function describeChannels(version: string): string {
  const v = parseVersion(version);
  if (canaryNumber(v) !== undefined) {
    return 'Docker nathapp/koda-api:canary + nathapp/koda-web:canary, npm dist-tag canary';
  }
  return [
    `Docker nathapp/koda-api:v${version} + nathapp/koda-web:v${version}`,
    `(also ${v.major}.${v.minor} and latest when it is the newest release),`,
    'npm dist-tag latest when newest',
  ].join(' ');
}
