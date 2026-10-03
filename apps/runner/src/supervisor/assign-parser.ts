import type { AssignPayload, BashMode, FleetCommandOut } from '@nathapp/fleet-protocol';
import { assertCloneUrl } from '../executor/workspace';
import { COST_RE, PROFILE_NAME, RESERVED_PREFIX } from '../executor/nax-process';
import { PathError, assertFeature, assertOwner, assertRelativePath, assertSegment } from '../paths/safe-segment';

export type ParsedAssign = { ok: true; assign: AssignPayload } | { ok: false; detail: string };

const BASH_MODES: readonly string[] = ['raw', 'gated', 'escalate'];
const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): ParsedAssign => ({ ok: false, detail: `invalid ${what}` });
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const hasControl = (v: string): boolean => [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const plain = (v: unknown, max: number): v is string => text(v, max) && !hasControl(v);

function checked(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof PathError) return false;
    throw error;
  }
}

/** @design API-1: `checked`'s re-throw policy cannot be reached through `parseAssign` (all validators throw `PathError`),
 *  so it is exported under a test-only name rather than widened into the public parse surface. */
export const __checked = checked;

/**
 * D30: the server is trusted to deliver, not to be well formed. Every field that reaches a path, an argv or git config
 * is re-validated, and only the validated fields are copied. `ref` is only bounded here: an odd ref becomes a fixed
 * `checkout:` reason in prepare, not a rejected command.
 */
export function parseAssign(command: FleetCommandOut): ParsedAssign {
  const p = command.payload as unknown;
  if (!isObj(p)) return bad('payload');
  if (p['jobId'] !== command.jobId || !checked(() => assertSegment('jobId', p['jobId']))) return bad('jobId');
  if (p['command'] !== 'RUN' && p['command'] !== 'PLAN') return bad('command');
  const repo = p['repo'];
  if (!isObj(repo) || (repo['provider'] !== 'github' && repo['provider'] !== 'gitlab')) return bad('repo');
  if (!checked(() => assertOwner(repo['owner']))) return bad('owner');
  if (!checked(() => assertSegment('repo', repo['name']))) return bad('repo name');
  if (!text(repo['cloneUrl'], 2_000) || !checked(() => assertCloneUrl(repo['cloneUrl'] as string))) return bad('cloneUrl');
  if (!plain(repo['defaultBranch'], 255)) return bad('defaultBranch');
  if (!plain(p['ref'], 255)) return bad('ref');
  if (!checked(() => assertFeature(p['feature']))) return bad('feature');
  const isPlan = p['command'] === 'PLAN';
  if (isPlan ? !checked(() => assertRelativePath('planFrom', p['planFrom'])) : p['planFrom'] !== null && p['planFrom'] !== undefined) return bad('planFrom');
  const profiles = p['profiles'];
  if (!Array.isArray(profiles) || profiles.length > 8 || !profiles.every((n) => typeof n === 'string' && PROFILE_NAME.test(n) && !n.startsWith(RESERVED_PREFIX))) return bad('profiles');
  if (typeof p['maxCostUsd'] !== 'string' || !COST_RE.test(p['maxCostUsd'])) return bad('maxCostUsd');
  if (typeof p['bashMode'] !== 'string' || !BASH_MODES.includes(p['bashMode']) || (isPlan && p['bashMode'] !== 'raw')) return bad('bashMode');
  // A server that predates S1.5 2a sends no timeout; it also only sends raw jobs.
  const approvalTimeoutSec = p['approvalTimeoutSec'] ?? DEFAULT_APPROVAL_TIMEOUT_SEC;
  if (typeof approvalTimeoutSec !== 'number' || !Number.isInteger(approvalTimeoutSec) || approvalTimeoutSec < 30 || approvalTimeoutSec > 3600) return bad('approvalTimeoutSec');
  const identity = p['gitIdentity'];
  if (!isObj(identity) || !plain(identity['name'], 200) || !plain(identity['email'], 200)) return bad('gitIdentity');
  return {
    ok: true,
    assign: {
      jobId: p['jobId'] as string,
      command: p['command'],
      repo: {
        provider: repo['provider'], owner: repo['owner'] as string, name: repo['name'] as string,
        defaultBranch: repo['defaultBranch'] as string, cloneUrl: repo['cloneUrl'] as string,
      },
      ref: p['ref'] as string,
      feature: p['feature'] as string,
      planFrom: isPlan ? (p['planFrom'] as string) : null,
      profiles: [...(profiles as string[])],
      maxCostUsd: p['maxCostUsd'],
      bashMode: p['bashMode'] as BashMode,
      approvalTimeoutSec,
      gitIdentity: { name: identity['name'] as string, email: identity['email'] as string },
    },
  };
}
