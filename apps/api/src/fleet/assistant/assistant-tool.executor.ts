import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { subject } from '@casl/ability';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { ProjectAccessService } from '../../projects/project-access.service';
import { withProjectRole } from '../../projects/project-context';
import { stableStringify } from '../sync/stable-json';
import { MAX_PENDING_ACTIONS, type ActionProposer, type PendingActionRecord } from './actions/pending-action.domain';
import { capText, fenceData, maskSecrets } from './assistant-tool-safety';
import { ASSISTANT_TOOL_CALL_REPOSITORY, type AssistantToolCallRecord, type AssistantToolCallRepository, type ToolCallContext, type ToolCallOutcome } from './assistant-tool-call.domain';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext, type ToolResult } from './assistant-tool.types';

/** The most bytes of one tool result the agent reads (S5b-R5). */
export const RESULT_CAP_BYTES = 16_384;

/** 2a-D4: the answer at `MAX_PENDING_ACTIONS`; the cap is in the text because the model can only lower the backlog. */
const REFUSED_CONTENT = `refused: ${MAX_PENDING_ACTIONS} actions are pending in this thread; wait for the user to decide them`;

export interface ToolCall {
  jobId: string;
  toolCallId: string;
  name: string;
  input: unknown;
}

/** 2a-D8 step 8: what running an approved action answered. `text` is what the action stores as its result. */
export interface ActionOutcome {
  ok: boolean;
  text: string;
}

/** What an approved action runs with: the tool, and the requester acting with the action project's role. */
interface ActionScope {
  tool: AssistantTool;
  actor: UserPrincipal;
}

/** Fleet S5b §1 (US-002): runs a koda tool for the thread's creator, with the permission the creator would have in the web. */
@Injectable()
export class AssistantToolExecutor {
  private readonly logger = new Logger(AssistantToolExecutor.name);

  /** 2a-D1: attached by `AssistantActionService.onModuleInit`, which is how the two providers stay acyclic. */
  private actions: ActionProposer | null = null;

  constructor(
    private readonly registry: AssistantToolRegistry,
    @Inject(ASSISTANT_TOOL_CALL_REPOSITORY) private readonly calls: AssistantToolCallRepository,
    private readonly access: ProjectAccessService,
    private readonly abilities: KodaCaslAbilityFactory,
  ) {}

  /** 2a-D1: the late binding of the propose side; the constructor is unchanged so no provider depends on the service. */
  attachActions(actions: ActionProposer): void {
    this.actions = actions;
  }

  /**
   * 2a-D8 step 5: whether the requester may still run this action's tool. The requester is the thread creator of the
   * action's job, re-read now, and their membership and ability are re-resolved against the project the action acts
   * in (2a-D3) — never the thread's home project. A tool that left the registry, a job whose thread is gone and a
   * requester who is disabled, outside that project or without the tool's ability all answer `forbidden`, so an
   * approve writes nothing for any of them.
   */
  async checkAction(action: PendingActionRecord): Promise<'ok' | 'forbidden'> {
    return (await this.actionScope(action)) === null ? 'forbidden' : 'ok';
  }

  /**
   * 2a-D8 step 8: runs an approved action's tool as the requester. The context is built fresh from the action — its
   * project slug, its thread and job, a new fence — so nothing the proposing call held leaks in. The tool's own
   * failures are data, not exceptions: `not_found` for a target that is gone, a `ToolActionError`'s text for a tool
   * that failed partway (2b1-D2), `error: <tool> failed` for anything else, with the stack logged. A successful
   * result is capped at `RESULT_CAP_BYTES` before it is stored, exactly as a partial outcome's text is; the two
   * refusal texts are constants far below it.
   */
  async executeAction(action: PendingActionRecord): Promise<ActionOutcome> {
    const scope = await this.actionScope(action);
    if (!scope) return { ok: false, text: `error: ${action.tool} failed` };
    try {
      const text = await scope.tool.execute(this.actionContext(action, scope.actor), scope.tool.parse(action.input));
      return { ok: true, text: capText(text, RESULT_CAP_BYTES) };
    } catch (error) {
      if (error instanceof NotFoundAppException) return { ok: false, text: 'not_found' };
      // 2b1-D2: what the tool already wrote is the outcome, so it is answered as stored text and never logged as a
      // failure of its own. The action's `result` gets the same cap, so a long batch result stays readable.
      if (error instanceof ToolActionError) return { ok: false, text: capText(error.text, RESULT_CAP_BYTES) };
      this.logger.error(
        `koda action ${action.id} tool ${action.tool} failed for job ${action.jobId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { ok: false, text: `error: ${action.tool} failed` };
    }
  }

  /** The tool, the requester and the role an action runs with; null when any of the three gates refuses. */
  private async actionScope(action: PendingActionRecord): Promise<ActionScope | null> {
    const tool = this.registry.get(action.tool);
    if (!tool) return null;
    const context = await this.calls.findCallContext(action.jobId);
    if (!context || context.creator.disabled) return null;
    const requester = userPrincipal(context.creator);
    const role = await this.membership(action.projectId, requester);
    if (role === undefined) return null;
    const actor = withProjectRole(requester, role) as UserPrincipal;
    if (tool.permission.kind === 'ability') {
      const { action: caslAction, subject: target } = tool.permission;
      const ability = await this.abilities.createForUser(actor);
      if (!ability.can(caslAction as CaslPermissionAction, subject(target, {}))) return null;
    }
    return { tool, actor };
  }

  /** The action's own scope, exactly as `propose` recorded it: its project, its thread, its job and a fresh fence. */
  private actionContext(action: PendingActionRecord, actor: UserPrincipal): ToolContext {
    const token = randomBytes(8).toString('hex');
    return {
      projectId: action.projectId,
      projectSlug: action.projectSlug,
      actor,
      threadId: action.threadId,
      jobId: action.jobId,
      now: new Date(),
      data: (text) => fenceData(maskSecrets(text), token),
    };
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const inputHash = sha256(stableStringify(call.input));
    const stored = await this.calls.findByCall(call.jobId, call.toolCallId);
    if (stored) return this.replay(stored, call.name, inputHash);

    const tool = this.registry.get(call.name);
    if (!tool) throw new NotFoundAppException({}, 'fleet.assistantTool');

    const started = Date.now();
    const context = await this.calls.findCallContext(call.jobId);
    if (!context) throw new NotFoundAppException({}, 'fleet.jobs');

    const outcome = await this.run(call, tool, context);
    const content = capText(outcome.content, RESULT_CAP_BYTES);
    const row: AssistantToolCallRecord = {
      jobId: call.jobId,
      threadId: context.threadId,
      projectId: outcome.projectId ?? context.project.id,
      toolCallId: call.toolCallId,
      tool: call.name,
      inputHash,
      outcome: outcome.outcome,
      content,
      isError: isErrorOutcome(outcome.outcome),
      resultBytes: Buffer.byteLength(content),
      durationMs: Date.now() - started,
    };
    return this.store(row);
  }

  /** Step 1: a stored `(jobId, toolCallId)` answers itself; a different tool or input is a reused id. */
  private replay(stored: AssistantToolCallRecord, name: string, inputHash: string): ToolResult {
    if (stored.tool !== name || stored.inputHash !== inputHash) {
      return { content: 'invalid_input: toolCallId reused', isError: true };
    }
    return { content: stored.content, isError: stored.isError };
  }

  /** Steps 3 to 6: scope, parse, permission, execute. Every refusal is data for the agent. */
  private async run(call: ToolCall, tool: AssistantTool, context: ToolCallContext): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    if (context.creator.disabled) return refusal('forbidden', 'forbidden: the thread creator is disabled');

    const workspaceThread = context.kind === 'WORKSPACE';
    const workspaceTool = tool.scope === 'workspace';
    if (workspaceTool && !workspaceThread) return refusal('invalid_input', `invalid_input: ${name} is only available in workspace threads`);
    const hasProject = hasProjectKey(call.input);
    if (hasProject && (!workspaceThread || workspaceTool)) return refusal('invalid_input', 'invalid_input: project');

    const actor = userPrincipal(context.creator);
    if (workspaceTool) return this.execTool(call, tool, context, { id: context.project.id, slug: context.project.slug, actor, input: call.input });
    if (!workspaceThread) return this.runInHomeProject(call, tool, context, actor);
    return this.runInNamedProject(call, tool, context, actor);
  }

  /** REPO and PROJECT threads: the job's project, then `tool.parse`, then membership (today's path). */
  private async runInHomeProject(call: ToolCall, tool: AssistantTool, context: ToolCallContext, actor: UserPrincipal): Promise<RunOutcome> {
    const parsed = parseInput(tool, call.input);
    if ('refusal' in parsed) return parsed.refusal;
    const { id, slug } = context.project;
    const role = await this.membership(id, actor);
    if (role === undefined) return refusal('forbidden', `forbidden: ${tool.descriptor.name} needs project membership on ${slug}`);
    return this.execParsed(call, tool, context, { id, slug, actor: withProjectRole(actor, role) as UserPrincipal, input: parsed.value });
  }

  /** WORKSPACE threads, project-scoped tools (S5b-R7 steps 3 to 5): the `project` argument names the project. */
  private async runInNamedProject(call: ToolCall, tool: AssistantTool, context: ToolCallContext, actor: UserPrincipal): Promise<RunOutcome> {
    const slug = projectArgument(call.input);
    if (slug === null) return refusal('invalid_input', 'invalid_input: project');
    const id = await this.findProject(slug);
    const role = id === undefined ? undefined : await this.membership(id, actor);
    if (id === undefined || role === undefined) return refusal('not_found', 'not_found: project');

    const parsed = parseInput(tool, withoutProject(call.input));
    if ('refusal' in parsed) return { ...parsed.refusal, projectId: id };
    return this.execParsed(call, tool, context, { id, slug, actor: withProjectRole(actor, role) as UserPrincipal, input: parsed.value });
  }

  /** The project's id, or undefined for an unknown or soft-deleted slug. */
  private async findProject(slug: string): Promise<string | undefined> {
    try {
      return await this.access.findProjectIdBySlug(slug);
    } catch (error) {
      if (error instanceof NotFoundAppException) return undefined;
      throw error;
    }
  }

  /** The creator's role in the project, or undefined when they are not a member. */
  private async membership(projectId: string, actor: UserPrincipal): Promise<string | null | undefined> {
    try {
      return await this.access.resolveMembership(projectId, actor);
    } catch (error) {
      if (error instanceof ForbiddenAppException) return undefined;
      throw error;
    }
  }

  /** The ability check for the role the membership answered, then the tool. */
  private async execParsed(call: ToolCall, tool: AssistantTool, context: ToolCallContext, scope: ToolScope): Promise<RunOutcome> {
    if (tool.permission.kind === 'ability') {
      const { action, subject: target } = tool.permission;
      const ability = await this.abilities.createForUser(scope.actor);
      if (!ability.can(action as CaslPermissionAction, subject(target, {}))) {
        return { ...refusal('forbidden', `forbidden: ${tool.descriptor.name} needs ${action} ${target} on ${scope.slug}`), projectId: scope.id };
      }
    }
    return this.execTool(call, tool, context, scope);
  }

  private async execTool(call: ToolCall, tool: AssistantTool, context: ToolCallContext, scope: ToolScope): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    const token = randomBytes(8).toString('hex');
    const ctx: ToolContext = {
      projectId: scope.id,
      projectSlug: scope.slug,
      actor: scope.actor,
      threadId: context.threadId,
      jobId: call.jobId,
      now: new Date(),
      data: (text) => fenceData(maskSecrets(text), token),
    };
    if (tool.kind === 'write') return this.proposeWrite(call, tool, context, scope, ctx);
    try {
      return { outcome: 'ok', content: await tool.execute(ctx, scope.input), projectId: scope.id };
    } catch (error) {
      if (error instanceof NotFoundAppException) return { ...refusal('not_found', 'not_found'), projectId: scope.id };
      this.logger.error(`koda tool ${name} failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
  }

  /**
   * 2a-D2: a write tool never runs its own write. Everything up to here is today's path — creator, scope, `project`
   * argument, parse, membership and ability — so a caller who may not write is refused before a preview exists. The
   * preview is what the user approves, and `propose` is what turns it into a decision the thread can render.
   */
  private async proposeWrite(call: ToolCall, tool: AssistantTool, context: ToolCallContext, scope: ToolScope, ctx: ToolContext): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    const actions = this.actions;
    if (!actions) {
      this.logger.warn(`koda write tool ${name} has no action proposer attached; job ${call.jobId} answered error`);
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
    const prepare = tool.preview;
    if (!prepare) {
      this.logger.error(`koda write tool ${name} declares no preview; job ${call.jobId} answered error`);
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
    let preview: string;
    try {
      preview = await prepare(ctx, scope.input);
    } catch (error) {
      if (error instanceof NotFoundAppException) return { ...refusal('not_found', 'not_found'), projectId: scope.id };
      // 2b1-D1: a preview's own refusals are data for the agent, and both stop before `propose`, so no action exists.
      if (error instanceof ToolInputError) return { ...refusal('invalid_input', `invalid_input: ${error.reason}`), projectId: scope.id };
      if (error instanceof ToolForbiddenError) {
        return { ...refusal('forbidden', `forbidden: ${name} needs ${error.need} on ${scope.slug}`), projectId: scope.id };
      }
      this.logger.error(`koda tool ${name} failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
    const proposed = await actions.propose({
      projectId: scope.id,
      threadId: context.threadId,
      threadKind: context.kind ?? 'REPO',
      threadProjectSlug: context.project.slug,
      jobId: call.jobId,
      toolCallId: call.toolCallId,
      tool: name,
      // 2a-D3: `PendingAction.input` is the parsed input, and a write tool's parser answers a JSON object.
      input: scope.input as Record<string, unknown>,
      preview,
      requestedById: context.creator.id,
      now: ctx.now,
    });
    if ('refused' in proposed) return { ...refusal('refused', REFUSED_CONTENT), projectId: scope.id };
    return { ...refusal('pending', `pending ${proposed.actionId}: awaiting user approval; do not retry`), projectId: scope.id };
  }

  /** Step 8: audit and store; a concurrent duplicate answers the stored row instead. */
  private async store(row: AssistantToolCallRecord): Promise<ToolResult> {
    try {
      await this.calls.record(row);
    } catch (error) {
      if (!isUniqueViolation(error, 'toolCallId')) throw error;
      const winner = await this.calls.findByCall(row.jobId, row.toolCallId);
      if (!winner) throw error;
      return this.replay(winner, row.tool, row.inputHash);
    }
    return { content: row.content, isError: row.isError };
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const refusal = (outcome: ToolCallOutcome, content: string): RunOutcome => ({ outcome, content });

/** 2a-D4: the agent must not retry a write call the user has yet to decide, so `pending` is not an error. */
const isErrorOutcome = (outcome: ToolCallOutcome): boolean => outcome !== 'ok' && outcome !== 'pending';

/** `projectId` is the resolved project for a call that reached a tool scope; absent means the job's own project (1d2-D6). */
interface RunOutcome {
  outcome: ToolCallOutcome;
  content: string;
  projectId?: string;
}

/** What a tool runs in: the project it acts on, the actor with that project's role, and the input its parser sees. */
interface ToolScope {
  id: string;
  slug: string;
  actor: UserPrincipal;
  input: unknown;
}

const PROJECT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An input that is not an object has no `project` key. */
const hasProjectKey = (input: unknown): boolean => isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'project');

/**
 * The `project` argument when it is a slug; null for a missing, non-string or malformed one. Only the project slug
 * contract's pattern decides: the descriptor's `maxLength` is guidance for the model, and a slug that long is still a
 * slug the API may hold, so it is looked up rather than refused (M1).
 */
function projectArgument(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const value = input['project'];
  return typeof value === 'string' && PROJECT_SLUG.test(value) ? value : null;
}

/** A copy of the input without its `project` key. */
function withoutProject(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const { project: _project, ...rest } = input;
  return rest;
}

function parseInput(tool: AssistantTool, input: unknown): { value: unknown } | { refusal: RunOutcome } {
  try {
    return { value: tool.parse(input) };
  } catch (error) {
    if (error instanceof ToolInputError) return { refusal: refusal('invalid_input', `invalid_input: ${error.reason}`) };
    throw error;
  }
}

/** The creator acts with the principal their login would produce, without a project role until membership resolves one. */
function userPrincipal(creator: ToolCallContext['creator']): UserPrincipal {
  const role = creator.role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
  return {
    actorType: 'user',
    id: creator.id,
    name: creator.email,
    email: creator.email,
    role,
    projectRole: undefined,
    blacklisted: false,
    revoked: false,
    authorities: [role],
    extra: { sub: creator.id, email: creator.email, role },
  };
}
