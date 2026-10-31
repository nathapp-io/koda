import { ValidationAppException } from '@nathapp/nestjs-common';
import { PROFILE_NAME_RE } from '../common/capabilities';
import { DEFAULT_APPROVAL_TIMEOUT_SEC } from '../common/protocol';
import { REVIEW_FEATURE_PREFIX, reviewFeature } from '../common/review-jobs';
import type { BashMode } from '../common/protocol';
import type { NewFleetJob } from './domain/fleet-job.domain';
import type { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';

/** nax validateFeatureName (src/utils/feature-name.ts): a single path segment. */
export const FEATURE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** A conservative subset of git check-ref-format. */
export const GIT_REF_RE = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/@+-]{1,255}$/;
/** Reserved for the runner's per-job profile (spec §5.2 step 3). */
export const RESERVED_PROFILE_PREFIX = 'koda-job-';

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.dispatchInput');
}

function checkPlanFrom(path: string): string {
  if (path.length === 0 || path.length > 512 || path.startsWith('/') || path.startsWith('-') || /[\\\0]/.test(path)) fail('planFrom');
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) fail('planFrom');
  return path;
}

/** Spec §5.1 checks the DTO decorators cannot express; returns the insertable fields. */
export function normalizeDispatch(dto: DispatchFleetJobDto, defaultBranch: string): Omit<NewFleetJob, 'projectId' | 'requestedById'> {
  let feature: string;
  let ref: string;
  if (dto.command === 'REVIEW') {
    if (dto.prNumber === undefined) fail('prNumber required for REVIEW');
    if (dto.feature !== undefined) fail('feature is derived for REVIEW');
    if (dto.planFrom !== undefined) fail('planFrom is only for PLAN');
    if (dto.ref !== undefined) fail('ref is the default branch for REVIEW');
    if (dto.bashMode !== undefined && dto.bashMode !== 'raw') fail('bashMode must be raw for REVIEW');
    if ((dto.ticketRefs?.length ?? 0) > 0) fail('ticketRefs is not for REVIEW');
    feature = reviewFeature(dto.prNumber);
    ref = defaultBranch;
  } else {
    if (!dto.feature) fail('feature');
    if (dto.feature.startsWith(REVIEW_FEATURE_PREFIX)) fail('feature is reserved for REVIEW');
    if (dto.prNumber !== undefined) fail('prNumber is only for REVIEW');
    feature = dto.feature;
    if (!FEATURE_RE.test(feature) || feature.includes('..')) fail('feature');
    if (dto.command === 'PLAN' && !dto.planFrom) fail('planFrom required for PLAN');
    if (dto.command === 'RUN' && dto.planFrom !== undefined) fail('planFrom is only for PLAN');
    ref = dto.ref ?? defaultBranch;
  }
  const profiles = dto.profiles ?? [];
  if (profiles.some((p) => !PROFILE_NAME_RE.test(p) || p.startsWith(RESERVED_PROFILE_PREFIX))) fail('profiles');
  if (new Set(profiles).size !== profiles.length) fail('duplicate profile');
  if (!GIT_REF_RE.test(ref)) fail('ref');
  const bashMode: BashMode = dto.bashMode ?? 'raw';
  if (dto.command === 'PLAN' && bashMode !== 'raw') fail('bashMode must be raw for PLAN');
  return {
    repoId: dto.repoId,
    ref,
    command: dto.command,
    feature,
    planFrom: dto.command === 'PLAN' ? checkPlanFrom(dto.planFrom as string) : null,
    profiles: [...profiles],
    maxCostUsd: String(dto.maxCostUsd),
    bashMode,
    approvalTimeoutSec: dto.approvalTimeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC,
    selectorLabels: [...new Set(dto.selectorLabels ?? [])].sort(),
    pinnedRunnerId: dto.pinnedRunnerId ?? null,
  };
}
