import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { BashMode } from '../../common/protocol';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_DISPATCH_JOB } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { normalizeDispatch } from '../../jobs/dispatch-input';
import type { DispatchFleetJobDto } from '../../jobs/dto/dispatch-fleet-job.dto';
import type { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeRepoRef } from '../../knowledge/knowledge-index.domain';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { TICKET_REF } from './ticket-tools';
import { fleetWriteRefusal } from './fleet-write-refusal';
import { asRecord, jobPath } from './tool-input';

/**
 * Fleet S5b 2b2 US-003: `koda_dispatch_job` proposes one RUN or PLAN job on one of the thread's project repositories
 * and, once the user approves the proposal, dispatches it as the requester. A preview never dispatches anything; the
 * repository the preview resolved is resolved again by `execute`, and the job is never bound to the calling thread
 * (2b2-R1), so the thread keeps running its own turn while the job is placed.
 */

/** 2b2-D3: `owner/name`, the same rule the knowledge tools spell (`koda_kb_search`). */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** 2b2-D3: the commands this tool dispatches. CONFIG_EDIT, CONFIG_DRIFT and THREAD are not among them. */
const COMMANDS: readonly string[] = ['RUN', 'PLAN'];
/** 2b2-D3: the three bash modes a dispatch may carry (`BashMode`), and the field bounds the DTO spells. */
const BASH_MODES: readonly string[] = ['raw', 'gated', 'escalate'];
const MAX_FEATURE_CHARS = 128;
const MAX_REF_CHARS = 255;
const MAX_PLAN_FROM_CHARS = 512;
const MAX_PROFILES = 8;
const MAX_PROFILE_CHARS = 64;
const MAX_TICKET_REFS = 20;
const MIN_COST_USD = 0.0001;
const MAX_COST_USD = 10_000;

/** One proposed dispatch, as the parser accepted it. Every field is kept as written. */
export interface DispatchJobInput {
  repo: string;
  command: 'RUN' | 'PLAN';
  feature: string;
  maxCostUsd: number;
  ref?: string;
  planFrom?: string;
  profiles?: string[];
  bashMode?: BashMode;
  ticketRefs?: string[];
}

/**
 * `koda_dispatch_job` (2b2-D1): one RUN or PLAN job on one repository of the thread's project. `parse` bounds the
 * input, `preview` refuses a request that cannot run and words what the user approves, and `execute` — what an
 * approve runs — dispatches it through `FleetJobsService` as the requester.
 */
export function dispatchJobTool(fleetJobs: FleetJobsService, knowledge: KnowledgeIndexService): AssistantTool<DispatchJobInput> {
  return {
    descriptor: KODA_DISPATCH_JOB,
    // 2b2-D2: the same CASL tuple the dispatch route enforces (`fleet-jobs.controller.ts`).
    permission: { kind: 'ability', action: 'create', subject: 'FleetJob' },
    kind: 'write',
    parse(input: unknown): DispatchJobInput {
      const raw = asRecord(input);
      const repo = raw['repo'];
      if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) throw new ToolInputError('repo');
      const command = raw['command'];
      if (typeof command !== 'string' || !COMMANDS.includes(command)) throw new ToolInputError('command');
      const feature = requiredString(raw['feature'], 'feature', 1, MAX_FEATURE_CHARS);
      const maxCostUsd = requiredCost(raw['maxCostUsd']);
      const ref = optionalString(raw['ref'], 'ref', 1, MAX_REF_CHARS);
      const planFrom = optionalString(raw['planFrom'], 'planFrom', 1, MAX_PLAN_FROM_CHARS);
      const profiles = optionalProfiles(raw['profiles']);
      const bashMode = optionalBashMode(raw['bashMode']);
      const ticketRefs = optionalTicketRefs(raw['ticketRefs']);
      return {
        repo,
        command: command as DispatchJobInput['command'],
        feature,
        maxCostUsd,
        ...(ref === undefined ? {} : { ref }),
        ...(planFrom === undefined ? {} : { planFrom }),
        ...(profiles === undefined ? {} : { profiles }),
        ...(bashMode === undefined ? {} : { bashMode }),
        ...(ticketRefs === undefined ? {} : { ticketRefs }),
      };
    },
    /**
     * 2b2-D4/D5: the text the user approves — the repository, the ref, the feature, the cost cap and one line per
     * optional field, in the fixed order, the whole text masked. The repository is resolved first, so a foreign or
     * missing one raises `NotFoundAppException` and the executor answers `not_found` before any action exists; then
     * `normalizeDispatch` runs, so a request the service would refuse is refused here instead.
     */
    async preview(ctx: ToolContext, input: DispatchJobInput): Promise<string> {
      const repo = await resolveRepo(knowledge, ctx, input);
      assertDispatchable(input, repo);
      const lines = [
        `Dispatch ${input.command} in ${ctx.projectSlug}:`,
        `repo: ${repo.owner}/${repo.name} @ ${input.ref ?? repo.defaultBranch}`,
        `feature: ${input.feature}`,
        `max cost: $${String(input.maxCostUsd)}`,
      ];
      if (input.planFrom !== undefined) lines.push(`plan from: ${input.planFrom}`);
      if (input.profiles !== undefined) lines.push(`profiles: ${input.profiles.join(', ')}`);
      if (input.bashMode !== undefined) lines.push(`bash: ${input.bashMode}`);
      if (input.ticketRefs !== undefined) lines.push(`tickets: ${input.ticketRefs.join(', ')}`);
      return maskSecrets(lines.join('\n'));
    },
    /**
     * 2b2-D6: what an approve runs. The repository is resolved again — one deleted or moved between the proposal and
     * the approval is `not_found` before the service is called — and the dispatch runs as the requester with the
     * action project's role, so a RUN the tool proposed moves its tickets as the same user. No `threadId` is passed
     * (2b2-R1): the job is never bound to this thread. A refusal the service throws becomes the action's text
     * through `fleetWriteRefusal`; anything it cannot name is rethrown, so `not_found` still answers `not_found`.
     */
    async execute(ctx: ToolContext, input: DispatchJobInput): Promise<string> {
      const repo = await resolveRepo(knowledge, ctx, input);
      try {
        const result = await fleetJobs.dispatch(ctx.actor.id, ctx.projectId, toDto(input, repo.id), {
          ticketActor: { principal: ctx.actor, projectSlug: ctx.projectSlug },
        });
        const { id, state } = result.job;
        return `dispatched ${id}: ${state} ${jobPath(ctx.projectSlug, id)}`;
      } catch (error) {
        const refusal = fleetWriteRefusal(error);
        if (refusal === null) throw error;
        throw new ToolActionError(`dispatch refused: ${refusal}`);
      }
    },
  };
}

/**
 * The project's repository, resolved by `owner/name` so a repository of another project never resolves (2b2-D5).
 * `koda_kb_search` resolves the same way and answers the same exception.
 */
async function resolveRepo(knowledge: KnowledgeIndexService, ctx: ToolContext, input: DispatchJobInput): Promise<KnowledgeRepoRef> {
  const [owner = '', name = ''] = input.repo.split('/');
  const repo = await knowledge.resolveProjectRepo(ctx.projectId, { owner, name });
  if (!repo) throw new NotFoundAppException({}, 'knowledge.repoNotFound');
  return repo;
}

/** 2b2-D5: the checks `parse` cannot make. `normalizeDispatch`'s refusal is the parser's own reason. */
function assertDispatchable(input: DispatchJobInput, repo: KnowledgeRepoRef): void {
  try {
    normalizeDispatch(toDto(input, repo.id), repo.defaultBranch);
  } catch (error) {
    if (error instanceof ValidationAppException) throw new ToolInputError(String(error.args?.['reason'] ?? 'dispatch'));
    throw error;
  }
}

/** What the service takes: the resolved repository id and the input's own fields, absent fields left out (2b2-D6). */
function toDto(input: DispatchJobInput, repoId: string): DispatchFleetJobDto {
  return {
    repoId,
    command: input.command,
    feature: input.feature,
    maxCostUsd: input.maxCostUsd,
    ...(input.ref === undefined ? {} : { ref: input.ref }),
    ...(input.planFrom === undefined ? {} : { planFrom: input.planFrom }),
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
    ...(input.bashMode === undefined ? {} : { bashMode: input.bashMode }),
    ...(input.ticketRefs === undefined ? {} : { ticketRefs: input.ticketRefs }),
  };
}

/** A required string between its bounds; anything else is the named refusal (2b2-D3). */
function requiredString(value: unknown, reason: string, minChars: number, maxChars: number): string {
  if (typeof value !== 'string' || value.length < minChars || value.length > maxChars) throw new ToolInputError(reason);
  return value;
}

/** An absent field, or a string inside its own bounds; anything else is the named refusal (2b2-D3). */
function optionalString(value: unknown, reason: string, minChars: number, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, reason, minChars, maxChars);
}

/**
 * The cost cap: a finite number inside the dispatch DTO's bounds and at most 4 decimal places, judged as
 * `Number(x.toFixed(4)) === x` (2b2-D3, 2b2-R2 — there is no default cost).
 */
function requiredCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolInputError('maxCostUsd');
  if (value < MIN_COST_USD || value > MAX_COST_USD || Number(value.toFixed(4)) !== value) throw new ToolInputError('maxCostUsd');
  return value;
}

/** An absent field, or 1 to 8 profile names of 1 to 64 characters; anything else is the named refusal (2b2-D3). */
function optionalProfiles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PROFILES) throw new ToolInputError('profiles');
  for (const profile of value) requiredString(profile, 'profiles', 1, MAX_PROFILE_CHARS);
  return value as string[];
}

/** An absent field, or one of the three bash modes; anything else is the named refusal (2b2-D3). */
function optionalBashMode(value: unknown): BashMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !BASH_MODES.includes(value)) throw new ToolInputError('bashMode');
  return value as BashMode;
}

/**
 * An absent field, or 1 to 20 ticket refs; anything else is the named refusal (2b2-D3). The refs themselves are not
 * checked against the project — an unknown or unlinkable one fails the approved action, not the proposal.
 */
function optionalTicketRefs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TICKET_REFS) throw new ToolInputError('ticketRefs');
  for (const ref of value) {
    if (typeof ref !== 'string' || !TICKET_REF.test(ref)) throw new ToolInputError('ticketRefs');
  }
  return value as string[];
}
