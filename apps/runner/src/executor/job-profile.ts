import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelayEndpoint } from '../approvals/approval-relay';
import { NAX_TRIGGER_NAMES } from '../approvals/nax-triggers';
import { assertSegment } from '../paths/safe-segment';

/**
 * Design §2 step 5: `<owner>/<repo>` lowercased, every character outside [a-z0-9_-] replaced by `-`, leading
 * `-`, `_` and `.` stripped, truncated to 55, then `-` and the first 8 hex of SHA-256(`<owner>/<repo>`).
 * nax requires /^[a-z0-9_-]+$/, at most 64 characters, not starting with `.` or `_`.
 */
export function projectNameFor(owner: string, repo: string): string {
  const key = `${owner}/${repo}`;
  const base = key.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_.]+/, '').slice(0, 55);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${base === '' ? 'repo' : base}-${hash}`;
}

export const jobProfileName = (jobId: string): string => `koda-job-${assertSegment('jobId', jobId)}`;

export const jobProfilePath = (naxHome: string, jobId: string): string => join(naxHome, 'profiles', `${jobProfileName(jobId)}.json`);

export interface RelayOverlay {
  readonly bashMode: 'gated' | 'escalate';
  readonly approvalTimeoutSec: number;
  readonly endpoint: RelayEndpoint;
}

/** Spec §4.1 / plan D275. Profiles deep-merge after the repo config, so these keys win; callbackPort 0 overrides a pinned one. */
export function jobProfileContent(outputDir: string, projectName: string, relay?: RelayOverlay): Record<string, unknown> {
  if (!relay) return { outputDir, name: projectName };
  return {
    outputDir, name: projectName,
    execution: { bashApproval: relay.bashMode, approvalTimeout: relay.approvalTimeoutSec * 1000 },
    interaction: {
      plugin: 'webhook',
      config: { url: relay.endpoint.url, secret: relay.endpoint.secret, requireSecret: true, callbackPort: 0 },
      triggers: Object.fromEntries(NAX_TRIGGER_NAMES.map((name) => [name, false])),
    },
  };
}

/** A raw overlay is appended last to the chain; it must exist until nax exits (SP-1). Mode 0600: it may hold the relay secret. */
export async function writeJobProfile(naxHome: string, jobId: string, outputDir: string, projectName: string, relay?: RelayOverlay): Promise<string> {
  const path = jobProfilePath(naxHome, jobId);
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(jobProfileContent(outputDir, projectName, relay), null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

export async function deleteJobProfile(naxHome: string, jobId: string): Promise<void> {
  await rm(jobProfilePath(naxHome, jobId), { force: true });
}

/** A crash can leave profiles of finished jobs behind; the daemon removes those at start. */
export async function sweepOrphanProfiles(naxHome: string, keepJobIds: ReadonlySet<string>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(naxHome, 'profiles'));
  } catch {
    return [];
  }
  const orphans = names.filter((name) => {
    const m = /^koda-job-(.+)\.json$/.exec(name);
    return m !== null && !keepJobIds.has(m[1]);
  });
  await Promise.all(orphans.map((name) => rm(join(naxHome, 'profiles', name), { force: true })));
  return orphans;
}
