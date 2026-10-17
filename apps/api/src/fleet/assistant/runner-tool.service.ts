import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { FleetCommandType } from '../../common/enums';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { isThreadKind } from '../common/thread-jobs';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from '../sync/fence.service';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { ToolResult } from './assistant-tool.types';

/** The same bound the log upload enforces on its `leaseEpoch` query (LogUploadService.parse). */
const NON_NEG_INT = /^(0|[1-9][0-9]{0,15})$/;
/** `toolCallId`: 1 to 200 printable ASCII characters, the same alphabet the audit's `inputHash` replay compares. */
const TOOL_CALL_ID = /^[\x20-\x7e]{1,200}$/;
/** The job state a tool call may run in: RUNNING only. UPLOADING means the turn's session is over. */
const CALLABLE_STATE = 'RUNNING';

interface ParsedCall {
  leaseEpoch: number;
  toolCallId: string;
  input: unknown;
}

/**
 * Fleet S5b US-005 (1b-D8): the runner tool route's checks live here, so the controller only maps parameters.
 * The route is job-scoped (1b-R1): the runner proves it holds the job's lease with `?leaseEpoch=<n>`, and the thread
 * the tools act in is the job's `threadId`. Every refusal is an HTTP error of the route; everything past the last
 * gate is `{ content, isError }` data the agent reads (1b-D2).
 */
@Injectable()
export class RunnerToolService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById' | 'findPendingCommand' | 'findThreadTokenScope'>,
    private readonly fence: FenceService,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'threadsEnabled'>,
    private readonly registry: AssistantToolRegistry,
    private readonly executor: AssistantToolExecutor,
  ) {}

  /** The route's checks in the spec's order, then the executor. The caller never queues an ABANDON: the sync path owns it. */
  async call(runnerId: string, jobId: string, leaseEpochRaw: string | undefined, name: string, body: unknown): Promise<ToolResult> {
    const call = parseToolCall(leaseEpochRaw, body);
    if (!this.cfg.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    if (!this.fence.holds(job, runnerId, call.leaseEpoch)) throw new FleetFenceException();
    if (!isThreadKind(job.command) || !job.threadId) throw new ConflictAppException({}, 'fleet.notThreadJob');
    if ((await this.jobs.findThreadTokenScope(jobId))?.kind === 'WORKSPACE') throw new ConflictAppException({}, 'fleet.notThreadJob');
    if (job.state !== CALLABLE_STATE) throw new ConflictAppException({ state: job.state }, 'fleet.jobState');
    const closing = await this.jobs.findPendingCommand({ jobId, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: job.leaseEpoch });
    if (closing) throw new ConflictAppException({}, 'threads.closing');
    // Looked up on every call, replays included (1b-D2): a tool the API no longer serves is a 404, never a replay.
    if (!this.registry.get(name)) throw new NotFoundAppException({}, 'fleet.assistantTool');
    return this.executor.execute({ jobId, toolCallId: call.toolCallId, name, input: call.input });
  }
}

/**
 * The query and body contract: `leaseEpoch` a non-negative integer, the body `{ toolCallId, input }`. A missing or
 * unusable field is the route's own 400; the tool's own parser judges the `input` value (1b-D5).
 */
function parseToolCall(leaseEpochRaw: string | undefined, body: unknown): ParsedCall {
  const bad = (reason: string): never => {
    throw new ValidationAppException({ reason }, 'fleet.toolCall');
  };
  if (!NON_NEG_INT.test(leaseEpochRaw ?? '')) return bad('leaseEpoch');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('body');
  const { toolCallId, input } = body as Record<string, unknown>;
  if (typeof toolCallId !== 'string' || !TOOL_CALL_ID.test(toolCallId)) return bad('toolCallId');
  if (!Object.prototype.hasOwnProperty.call(body, 'input')) return bad('input');
  return { leaseEpoch: Number(leaseEpochRaw), toolCallId, input };
}
