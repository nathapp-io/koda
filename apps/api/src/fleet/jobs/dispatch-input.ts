import { ValidationAppException } from '@nathapp/nestjs-common';
import { PROFILE_NAME_RE } from '../common/capabilities';
import { DEFAULT_APPROVAL_TIMEOUT_SEC } from '../common/protocol';
import { REVIEW_FEATURE_PREFIX, reviewFeature } from '../common/review-jobs';
import type { BashMode } from '../common/protocol';
import { AGENT_MODEL_ALIAS_KEY_RE, AGENT_MODEL_ALIAS_MAX_ENTRIES, AGENT_MODEL_MAX_LENGTH, AGENT_NAME_RE, AGENT_TASK_MAX_LENGTH, AGENT_TIMEOUT_MAX_SEC, AGENT_TIMEOUT_MIN_SEC, isModelAliasTarget } from '../common/agent-jobs';
import type { AgentJobInput } from '../common/agent-jobs';
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
  if (dto.agent !== undefined && dto.command !== 'AGENT') fail('agent is only for AGENT');
  if (dto.command === 'AGENT' && dto.agent == null) fail('agent required for AGENT');
  if (dto.command === 'AGENT' && dto.bashMode !== undefined && dto.bashMode !== 'raw') fail('bashMode must be raw for AGENT');
  if (dto.command === 'AGENT') {
    const agent: unknown = dto.agent;
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) fail('agent.name');
    const input = agent as Record<string, unknown>;
    if (typeof input.name !== 'string' || !AGENT_NAME_RE.test(input.name) || input.name.includes('..')) fail('agent.name');
    if (typeof input.task !== 'string' || input.task.length < 1 || input.task.length > AGENT_TASK_MAX_LENGTH || !/\S/.test(input.task)) fail('agent.task');
    if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length < 1 || input.model.length > AGENT_MODEL_MAX_LENGTH || /\s/.test(input.model))) fail('agent.model');
    if (input.modelAliases !== undefined) {
      const aliases = input.modelAliases;
      if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) fail('agent.modelAliases');
      const entries = Object.entries(aliases);
      if (entries.length > AGENT_MODEL_ALIAS_MAX_ENTRIES || entries.some(([key, target]) => !AGENT_MODEL_ALIAS_KEY_RE.test(key) || !isModelAliasTarget(target))) fail('agent.modelAliases');
    }
    if (input.timeoutSec !== undefined && (!Number.isInteger(input.timeoutSec) || (input.timeoutSec as number) < AGENT_TIMEOUT_MIN_SEC || (input.timeoutSec as number) > AGENT_TIMEOUT_MAX_SEC)) fail('agent.timeoutSec');
  }
  if (dto.command === 'AGENT' && (dto.ticketRefs?.length ?? 0) > 0) fail('ticketRefs is not for AGENT');

  let feature: string;
  let ref: string;
  if (dto.command === 'REVIEW' || dto.command === 'FIX') {
    const command = dto.command;
    if (dto.prNumber === undefined || dto.prNumber === null) fail(`prNumber required for ${command}`);
    if (dto.feature !== undefined) fail(`feature is derived for ${command}`);
    if (dto.planFrom !== undefined) fail('planFrom is only for PLAN');
    if (dto.ref !== undefined) fail(`ref is the default branch for ${command}`);
    if (dto.bashMode !== undefined && dto.bashMode !== 'raw') fail(`bashMode must be raw for ${command}`);
    if ((dto.ticketRefs?.length ?? 0) > 0) fail(`ticketRefs is not for ${command}`);
    feature = reviewFeature(dto.prNumber);
    ref = defaultBranch;
  } else {
    if (!dto.feature) fail('feature');
    if (dto.feature.startsWith(REVIEW_FEATURE_PREFIX)) fail('feature is reserved for REVIEW and FIX');
    if (dto.prNumber !== undefined) fail('prNumber is only for REVIEW and FIX');
    feature = dto.feature;
    if (!FEATURE_RE.test(feature) || feature.includes('..')) fail('feature');
    if (dto.command === 'PLAN' && !dto.planFrom) fail('planFrom required for PLAN');
    if (dto.planFrom !== undefined && dto.command !== 'PLAN') fail('planFrom is only for PLAN');
    ref = dto.ref ?? defaultBranch;
  }
  const profiles = dto.profiles ?? [];
  if (profiles.some((p) => !PROFILE_NAME_RE.test(p) || p.startsWith(RESERVED_PROFILE_PREFIX))) fail('profiles');
  if (new Set(profiles).size !== profiles.length) fail('duplicate profile');
  if (!GIT_REF_RE.test(ref)) fail('ref');
  const bashMode: BashMode = dto.bashMode ?? 'raw';
  if (dto.command === 'PLAN' && bashMode !== 'raw') fail('bashMode must be raw for PLAN');
  const agentInput: AgentJobInput | null = dto.command === 'AGENT' && dto.agent
    ? { name: dto.agent.name, task: dto.agent.task, ...(dto.agent.model !== undefined ? { model: dto.agent.model } : {}), ...(dto.agent.modelAliases !== undefined ? { modelAliases: dto.agent.modelAliases } : {}), ...(dto.agent.timeoutSec !== undefined ? { timeoutSec: dto.agent.timeoutSec } : {}) }
    : null;
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
    agentInput,
  };
}
