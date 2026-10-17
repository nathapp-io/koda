import { Injectable, type OnModuleInit } from '@nestjs/common';
import { FleetJobState } from '../../../common/enums';
import { AnalyticsService } from '../../analytics/analytics.service';
import { APPROVAL_STATUSES, type ApprovalStatus } from '../../approvals/domain/approval.domain';
import { ApprovalsService, type ApprovalRoute } from '../../approvals/approvals.service';
import type { FleetJobFilters } from '../../jobs/domain/fleet-job.domain';
import type { FleetJobDto } from '../../jobs/dto/fleet-job.dto';
import { FleetJobsService } from '../../jobs/fleet-jobs.service';
import { LOG_STREAMS, type LogStreamName } from '../../logs/domain/fleet-job-log.domain';
import { LOG_LEVELS, type LogEntryView, type LogLevel } from '../../logs/log-entry';
import { FleetLogExpiredException } from '../../logs/log-read.exceptions';
import { LogReadService } from '../../logs/log-read.service';
import { RunnersService } from '../../runners/runners.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import {
  KODA_FLEET_SPEND, KODA_GET_JOB, KODA_JOB_LOG_EXCERPT, KODA_LIST_APPROVALS, KODA_LIST_JOBS, KODA_RUNNER_STATUS,
} from '../koda-tool-descriptors';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { jobPath } from './tool-input';

/**
 * Fleet S5b US-004: the six fleet read tools. The project is the thread's project (S5b-R7) — no tool takes a
 * project argument, and every read goes through a project-scoped service, so an id of another project is
 * `not_found`. The permission is project membership (1b-D1): `FleetJob` reads are not a CASL permission for
 * non-admins. Input is parsed by hand (1b-D5); the descriptor's `inputSchema` is what the model sees.
 */

/** Every list tool asks the API for one page of 20 (1b §Tool catalog). */
const PAGE_SIZE = 20;
/** `koda_runner_status` reads the first 50 runners and has no page input (1b §Tool catalog). */
const RUNNER_PAGE_SIZE = 50;
const MAX_FEATURE_CHARS = 100;
const MAX_QUERY_CHARS = 100;
const DEFAULT_SPEND_DAYS = 7;
const MIN_SPEND_DAYS = 1;
const MAX_SPEND_DAYS = 90;
const DEFAULT_LOG_LIMIT = 20;
const MIN_LOG_LIMIT = 1;
const MAX_LOG_LIMIT = 50;
const DAY_MS = 86_400_000;

interface ListJobsInput {
  state?: FleetJobState;
  feature?: string;
  page: number;
}

interface GetJobInput {
  jobId: string;
}

interface FleetSpendInput {
  days: number;
}

interface ListApprovalsInput {
  status: ApprovalStatus;
  page: number;
}

interface JobLogExcerptInput {
  jobId: string;
  stream: LogStreamName;
  level?: LogLevel;
  query?: string;
  limit: number;
}

/** The input as a record; a missing key, a null and a non-object body all read as absent fields. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** An optional field that must be one of `allowed`; absent and null are both "not given". */
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new ToolInputError(reason);
  return value as T;
}

/** A required non-empty string. */
function requiredString(value: unknown, reason: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ToolInputError(reason);
  return value;
}

/** An optional string of 1 to `maxChars` characters. */
function optionalText(value: unknown, maxChars: number, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxChars) throw new ToolInputError(reason);
  return value;
}

/** An optional 1-based page number. */
function optionalPage(value: unknown, reason: string): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolInputError(reason);
  return value;
}

/** An optional integer inside `min`..`max`, defaulting when absent. */
function optionalInteger(value: unknown, min: number, max: number, fallback: number, reason: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ToolInputError(reason);
  return value;
}

/** The last line of a full page. */
const moreLine = (tool: string, nextPage: number): string => `more: call ${tool} with page ${nextPage}`;

/** `<label>` on one line, the fence under it; `(none)` when the field has no value. */
function labelled(ctx: ToolContext, label: string, value: string | null | undefined): string[] {
  return value === undefined || value === null || value === '' ? [`${label}: (none)`] : [`${label}:`, ctx.data(value)];
}

/** The text of one log entry: a parsed entry carries its `message`, an unparsed line its raw text. */
function entryText(entry: LogEntryView): string {
  return entry.message ?? entry.text ?? '';
}

/**
 * A parsed entry's timestamp is untrusted: the `run` stream is written by the job itself, so the field can hold
 * anything — a newline, a fake instruction, a credential. Only a strict ISO-8601 instant is emitted; any other
 * value is treated as absent, so a label can never take a line of its own or carry a secret out of the fence.
 */
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The entry's timestamp when it is a strict instant; `level` needs no check — it is one of `LOG_LEVELS`. */
function entryTimestamp(entry: LogEntryView): string | undefined {
  return typeof entry.timestamp === 'string' && LOG_TIMESTAMP.test(entry.timestamp) ? entry.timestamp : undefined;
}

/** `<timestamp> <level>`, either part omitted when the entry does not carry it (or when the timestamp is not an instant). */
function entryLabel(entry: LogEntryView): string {
  return [entryTimestamp(entry), entry.level].filter((part): part is string => typeof part === 'string').join(' ');
}

/**
 * `koda_list_jobs` (US-004): one page of the project's jobs, newest first. Filters go to the project-scoped
 * list, so another project's job can never appear.
 */
export function listJobsTool(jobs: FleetJobsService): AssistantTool<ListJobsInput> {
  return {
    descriptor: KODA_LIST_JOBS,
    permission: { kind: 'member' },
    parse(input: unknown): ListJobsInput {
      const raw = asRecord(input);
      return {
        state: optionalEnum(raw.state, Object.values(FleetJobState), 'state'),
        feature: optionalText(raw.feature, MAX_FEATURE_CHARS, 'feature'),
        page: optionalPage(raw.page, 'page'),
      };
    },
    async execute(ctx: ToolContext, input: ListJobsInput): Promise<string> {
      const filters: FleetJobFilters = {
        projectId: ctx.projectId,
        ...(input.state ? { state: input.state } : {}),
        ...(input.feature ? { feature: input.feature } : {}),
      };
      const page = await jobs.list(filters, { current: input.page, size: PAGE_SIZE });
      if (page.records.length === 0) return 'no jobs';
      const lines = page.records.map(
        (job) => `${job.id} ${job.command} ${job.state} ${job.feature} ${job.costSpentUsd} ${job.queuedAt} ${jobPath(ctx.projectSlug, job.id)}`,
      );
      if (page.hasNext) lines.push(moreLine(KODA_LIST_JOBS.name, input.page + 1));
      return lines.join('\n');
    },
  };
}

/** `job.stateReason`, `job.escalationReason` and `job.resultPrUrl` in the order the contract lists them. */
function jobResultLines(ctx: ToolContext, job: FleetJobDto): string[] {
  return [
    ...labelled(ctx, 'stateReason', job.stateReason),
    ...labelled(ctx, 'escalationReason', job.escalationReason),
    ...labelled(ctx, 'resultPrUrl', job.resultPrUrl),
  ];
}

/**
 * `koda_get_job` (US-004): one job of the thread's project. `FleetJobsService.get` scopes the id to the
 * project and raises `NotFoundAppException` for a foreign or missing one, which the executor answers as
 * `not_found`. The job's story list is deliberately not emitted.
 */
export function getJobTool(jobs: FleetJobsService): AssistantTool<GetJobInput> {
  return {
    descriptor: KODA_GET_JOB,
    permission: { kind: 'member' },
    parse(input: unknown): GetJobInput {
      return { jobId: requiredString(asRecord(input).jobId, 'jobId') };
    },
    async execute(ctx: ToolContext, input: GetJobInput): Promise<string> {
      // Scope first: `get` is what turns a foreign or missing id into not_found.
      const job = await jobs.get(ctx.projectId, input.jobId);
      return [
        `${job.id} ${job.command} ${job.state} ${job.feature} ref: ${job.ref} ${jobPath(ctx.projectSlug, job.id)}`,
        `costSpentUsd: ${job.costSpentUsd} maxCostUsd: ${job.maxCostUsd}`,
        `queuedAt: ${job.queuedAt} finishedAt: ${job.finishedAt ?? '(none)'}`,
        ...jobResultLines(ctx, job),
      ].join('\n');
    },
  };
}

/**
 * `koda_fleet_spend` (US-004): the project's spend over the last `days` days. The window ends at `ctx.now`, the
 * executor's clock, so the tool never reads the wall clock itself.
 */
export function fleetSpendTool(analytics: AnalyticsService): AssistantTool<FleetSpendInput> {
  return {
    descriptor: KODA_FLEET_SPEND,
    permission: { kind: 'member' },
    parse(input: unknown): FleetSpendInput {
      return { days: optionalInteger(asRecord(input).days, MIN_SPEND_DAYS, MAX_SPEND_DAYS, DEFAULT_SPEND_DAYS, 'days') };
    },
    async execute(ctx: ToolContext, input: FleetSpendInput): Promise<string> {
      const from = new Date(ctx.now.getTime() - input.days * DAY_MS);
      const spend = await analytics.spend(ctx.projectId, { from: from.toISOString(), to: ctx.now.toISOString() }, ctx.now);
      const { totals } = spend;
      return [
        `from: ${spend.window.from} to: ${spend.window.to}`,
        `totals.costUsd: ${totals.costUsd}`,
        `totals.jobs: ${totals.jobs}`,
        `totals.tokens: ${totals.tokens}`,
        `totals.medianJobCostUsd: ${totals.medianJobCostUsd ?? '(none)'}`,
      ].join('\n');
    },
  };
}

/**
 * `koda_list_approvals` (US-004): one page of the project's approvals through the project route, so another
 * project's approval can never appear. `role` follows the executor's resolved membership (1b-D1).
 */
export function listApprovalsTool(approvals: ApprovalsService): AssistantTool<ListApprovalsInput> {
  return {
    descriptor: KODA_LIST_APPROVALS,
    permission: { kind: 'member' },
    parse(input: unknown): ListApprovalsInput {
      const raw = asRecord(input);
      return {
        status: optionalEnum(raw.status, APPROVAL_STATUSES, 'status') ?? 'pending',
        page: optionalPage(raw.page, 'page'),
      };
    },
    async execute(ctx: ToolContext, input: ListApprovalsInput): Promise<string> {
      const route: ApprovalRoute = { kind: 'project', projectId: ctx.projectId, role: ctx.actor.projectRole ?? null };
      const page = await approvals.list(route, { status: input.status }, { current: input.page, size: PAGE_SIZE });
      if (page.records.length === 0) return 'no approvals';
      const lines = page.records.map(
        (approval) => `${approval.id} ${approval.type} ${approval.status} ${approval.jobId ?? '(none)'} ${approval.requestedAt}`,
      );
      if (page.hasNext) lines.push(moreLine(KODA_LIST_APPROVALS.name, input.page + 1));
      return lines.join('\n');
    },
  };
}

/**
 * `koda_runner_status` (US-004): the first 50 runners as a project member sees them. There is no page input,
 * and the runner-supplied name and labels are fenced.
 */
export function runnerStatusTool(runners: RunnersService): AssistantTool<Record<string, never>> {
  return {
    descriptor: KODA_RUNNER_STATUS,
    permission: { kind: 'member' },
    parse(): Record<string, never> {
      return {};
    },
    async execute(ctx: ToolContext): Promise<string> {
      const page = await runners.listSummaries({ current: 1, size: RUNNER_PAGE_SIZE }, ctx.now);
      if (page.records.length === 0) return 'no runners';
      const lines: string[] = [];
      for (const runner of page.records) {
        lines.push(`- online: ${runner.online} enabled: ${runner.enabled} projectThreads: ${runner.projectThreads}`);
        lines.push(...labelled(ctx, 'name', runner.name));
        lines.push(...labelled(ctx, 'labels', runner.labels.join(', ')));
      }
      return lines.join('\n');
    },
  };
}

/**
 * `koda_job_log_excerpt` (US-004): the newest matching entries of one stream, oldest first, with the scan
 * metadata the read service reports. Retention removing the stream is a successful result, not an error.
 */
export function jobLogExcerptTool(logs: LogReadService): AssistantTool<JobLogExcerptInput> {
  return {
    descriptor: KODA_JOB_LOG_EXCERPT,
    permission: { kind: 'member' },
    parse(input: unknown): JobLogExcerptInput {
      const raw = asRecord(input);
      const jobId = requiredString(raw.jobId, 'jobId');
      const stream = optionalEnum(raw.stream, LOG_STREAMS, 'stream') ?? 'run';
      const level = optionalEnum(raw.level, LOG_LEVELS, 'level');
      // 1b §Tool catalog: the `run` stream is the only one with parsed levels, so a level with stdout or stderr is input the tool cannot use.
      if (level !== undefined && stream !== 'run') throw new ToolInputError('level');
      return {
        jobId, stream, level,
        query: optionalText(raw.query, MAX_QUERY_CHARS, 'query'),
        limit: optionalInteger(raw.limit, MIN_LOG_LIMIT, MAX_LOG_LIMIT, DEFAULT_LOG_LIMIT, 'limit'),
      };
    },
    async execute(ctx: ToolContext, input: JobLogExcerptInput): Promise<string> {
      let page: Awaited<ReturnType<LogReadService['entries']>>;
      try {
        page = await logs.entries(ctx.projectId, input.jobId, input.stream, {
          direction: 'backward', limit: input.limit,
          ...(input.level ? { level: input.level } : {}),
          ...(input.query ? { q: input.query } : {}),
        });
      } catch (error) {
        if (error instanceof FleetLogExpiredException) return `expired: the logs of job ${input.jobId} were removed by retention`;
        throw error;
      }
      const lines = [
        `stream ${input.stream}, scanned ${page.scannedTo - page.scannedFrom} bytes, truncated: ${page.truncated}, complete: ${page.complete}`,
      ];
      if (page.entries.length === 0) lines.push('no entries');
      for (const entry of page.entries) {
        const label = entryLabel(entry);
        if (label !== '') lines.push(label);
        lines.push(ctx.data(entryText(entry)));
      }
      return lines.join('\n');
    },
  };
}

/** The US-004 tool group (1b-D7): registers the fleet read tools with the registry at bootstrap. */
@Injectable()
export class FleetTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly jobs: FleetJobsService,
    private readonly analytics: AnalyticsService,
    private readonly approvals: ApprovalsService,
    private readonly runners: RunnersService,
    private readonly logs: LogReadService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      listJobsTool(this.jobs),
      getJobTool(this.jobs),
      fleetSpendTool(this.analytics),
      listApprovalsTool(this.approvals),
      runnerStatusTool(this.runners),
      jobLogExcerptTool(this.logs),
    );
  }
}
