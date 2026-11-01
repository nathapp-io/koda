import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';

export const FIX_FOLLOW_UP = 'fleet_fix_follow_up';

export interface FixFollowUpPayload {
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  repoId: string;
  prNumber: number;
  headSha: string;
  requestedById: string;
  requestedByType: 'USER' | 'AGENT';
  profiles: string[];
  maxCostUsd: string;
}

export function buildFixFollowUpPayload(job: FleetJobRecord, prNumber: number, headSha: string): FixFollowUpPayload {
  return {
    jobId: job.id,
    leaseEpoch: job.leaseEpoch,
    projectId: job.projectId,
    repoId: job.repoId,
    prNumber,
    headSha,
    requestedById: job.requestedById,
    requestedByType: job.requestedByType ?? 'USER',
    profiles: [...job.profiles],
    maxCostUsd: job.maxCostUsd,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isString = (value: unknown): value is string => typeof value === 'string';

export function parseFixFollowUpPayload(raw: unknown): FixFollowUpPayload | null {
  if (!isObject(raw)) return null;
  const { jobId, leaseEpoch, projectId, repoId, prNumber, headSha, requestedById, requestedByType, profiles, maxCostUsd } = raw;
  if (
    !isString(jobId) || !isString(projectId) || !isString(repoId) || !isString(headSha) || !isString(requestedById)
    || !isString(maxCostUsd) || typeof leaseEpoch !== 'number'
    || !Number.isSafeInteger(prNumber) || (prNumber as number) <= 0
    || (requestedByType !== 'USER' && requestedByType !== 'AGENT')
    || !Array.isArray(profiles) || !profiles.every(isString)
  ) return null;
  return {
    jobId, leaseEpoch, projectId, repoId, prNumber: prNumber as number, headSha,
    requestedById, requestedByType, profiles, maxCostUsd,
  };
}
