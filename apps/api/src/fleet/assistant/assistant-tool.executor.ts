import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { isAgentPrincipal, type AgentPrincipal, type KodaAgentStatus, type UserPrincipal } from '../../auth/principal/koda-principal.types';
import { runWithActionContext, type ActionActor, type ActionApproval } from '../../action-context/action-context';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { KeyedMutex } from '../../common/utils/keyed-mutex';
import type { ApprovalMode } from '../../permissions/catalog';
import { PermissionService } from '../../permissions/permission.service';
import { ProjectAccessService } from '../../projects/project-access.service';
import { stableStringify } from '../sync/stable-json';
import { MAX_PENDING_ACTIONS, type ActionProposer, type PendingActionRecord } from './actions/pending-action.domain';
import { approvalModeFor } from './actions/approval-policy';
import { capText, fenceData, maskSecrets } from './assistant-tool-safety';
import {
  ASSISTANT_TOOL_CALL_REPOSITORY, type AgentToolCallCreator, type AssistantToolCallRecord, type AssistantToolCallRepository,
  type ToolCallContext, type ToolCallCreator, type ToolCallOutcome, type UserToolCallCreator,
} from './assistant-tool-call.domain';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolCaller, type ToolContext, type ToolResult } from './assistant-tool.types';

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

/** What an approved action runs with: the tool and the requester's own principal. */
interface ActionScope {
  tool: AssistantTool;
  actor: UserPrincipal;
}

/** Fleet S5b §1 (US-002): runs a koda tool for the job's requester — a user, or an agent — with the permission they would have in the web. */
@Injectable()
export class AssistantToolExecutor {
  private readonly logger = new Logger(AssistantToolExecutor.name);

  /** 2a-D1: attached by `AssistantActionService.onModuleInit`, which is how the two providers stay acyclic. */
  private actions: ActionProposer | null = null;

  /** B1: one critical section per replay key, so a duplicate of a thread call awaits the winner instead of running it. */
  private readonly replayKeys = new KeyedMutex();

  constructor(
    private readonly registry: AssistantToolRegistry,
    @Inject(ASSISTANT_TOOL_CALL_REPOSITORY) private readonly calls: AssistantToolCallRepository,
    private readonly access: ProjectAccessService,
    private readonly permissions: PermissionService,
  ) {}

  /** 2a-D1: the late binding of the propose side; the constructor is unchanged so no provider depends on the service. */
  attachActions(actions: ActionProposer): void {
    this.actions = actions;
  }

  /**
   * 2a-D8 step 5 + 3-D12: whether the requester may still run this action's tool. The requester is the action's own
   * actor — the principal that asked for the write, never the approver (3-R3) — re-read now, and their membership and
   * catalog key are re-resolved against the project the action acts in (2a-D3; permissions P1 US-004), never the
   * thread's home project. A tool that left the registry, an actor who is gone or disabled, an actor that is not a
   * user (no code default produces one; koda #301), a requester outside that project and a requester who no longer
   * holds the tool's key all answer `forbidden`, so an approve writes nothing for any of them.
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
   *
   * Both stored texts pass through `maskSecrets` first (branch review B2): whatever a tool echoes back — a URL a
   * link wrote, a batch line quoting one — becomes the action's `result`, and from there the text of the thread's
   * outcome note and of the next turn's delivery to the agent. Masking here is what keeps a credential a tool
   * merely repeated out of all three.
   */
  async executeAction(action: PendingActionRecord): Promise<ActionOutcome> {
    const scope = await this.actionScope(action);
    if (!scope) return { ok: false, text: `error: ${action.tool} failed` };
    try {
      // Permissions P1 US-001 / P2 US-003: the approve path runs the tool inside the assistant's action context on
      // behalf of the requester, carrying the action's own approval block, so a service the tool calls attributes its
      // writes to that principal (`actorTypeFor` reads `onBehalfOf`) and an audit row can name the approval.
      // `actionScope` admits users only, so the requester's type is USER; authority stays the requester's — the actor
      // here changes attribution only.
      const text = await runWithActionContext(
        {
          actor: ASSISTANT_ACTOR,
          onBehalfOf: { type: 'USER', id: scope.actor.id },
          origin: 'thread',
          approval: approvalFor(action),
        },
        () => scope.tool.execute(this.actionContext(action, scope.actor), scope.tool.parse(action.input)),
      );
      return { ok: true, text: capText(maskSecrets(text), RESULT_CAP_BYTES) };
    } catch (error) {
      if (error instanceof NotFoundAppException) return { ok: false, text: 'not_found' };
      // 2b1-D2: what the tool already wrote is the outcome, so it is answered as stored text and never logged as a
      // failure of its own. The action's `result` gets the same cap, so a long batch result stays readable.
      if (error instanceof ToolActionError) return { ok: false, text: capText(maskSecrets(error.text), RESULT_CAP_BYTES) };
      this.logger.error(
        `koda action ${action.id} tool ${action.tool} failed for job ${action.jobId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { ok: false, text: `error: ${action.tool} failed` };
    }
  }

  /**
   * The tool and the requester an action runs as; null when the registry, actor, membership or key gate refuses.
   */
  private async actionScope(action: PendingActionRecord): Promise<ActionScope | null> {
    const tool = this.registry.get(action.tool);
    if (!tool) return null;
    // 3-D12: the actor is the requesting principal (3-R3), so a non-user actor is refused before any read. Only MCP
    // actions carry one today, and no default serves them yet (koda #301).
    if (action.actorType !== 'user') return null;
    const requester = await this.calls.findUserActor(action.actorId);
    if (!requester || requester.disabled) return null;
    const principal = userPrincipal(requester);
    // The membership check still admits or refuses, but its display role no longer decorates the actor
    // (permissions P1 US-004): the tool acts as the requester's own principal.
    if ((await this.membership(action.projectId, principal)) === undefined) return null;
    // Permissions P1 US-004: the approve re-checks the tool's catalog key in the action's own project, exactly as
    // the proposing call checked it, so a requester who lost the key between the proposal and the approve writes
    // nothing. An implicit key answers allowed, as it does on the call path.
    if (!(await this.can(principal, tool.key, action.projectId))) return null;
    return { tool, actor: principal };
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
      can: (key) => this.can(actor, key, action.projectId),
    };
  }

  /**
   * The thread call path. Its replay key `(jobId, toolCallId)` is a critical section, not a read-then-write: a stored
   * row is answered as a replay, and a duplicate that arrives while the winner is still executing waits for it and then
   * replays the row the winner stored (branch fix B1). Without that, two concurrent requests carrying one replay key
   * both read no row, both ran the tool, and the later insert's unique violation only replayed the winning response —
   * so an agent's thread write (a comment, a ticket batch, a dispatch) landed twice.
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const inputHash = sha256(stableStringify(call.input));
    return this.replayKeys.run(replayKey(call.jobId, call.toolCallId), async () => {
      const stored = await this.calls.findByCall(call.jobId, call.toolCallId);
      if (stored) return this.replay(stored, call.name, inputHash);
      return this.executeUnstored(call, inputHash);
    });
  }

  /** The execution behind a replay key nobody stored: look the tool and its requester up, then run and audit it. */
  private async executeUnstored(call: ToolCall, inputHash: string): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) throw new NotFoundAppException({}, 'fleet.assistantTool');

    const started = Date.now();
    const context = await this.calls.findCallContext(call.jobId);
    if (!context) throw new NotFoundAppException({}, 'fleet.jobs');

    const creator = context.creator;
    // Permissions P1 US-001: `findCallContext` answers the job's requester, so an agent's turn runs as the agent and a
    // user's as the user. `disabled` stays a user's own flag: an agent's status is liveness, not access.
    const agent = isAgentCreator(creator);
    const caller: ToolCaller = {
      principal: agent ? agentPrincipal(creator) : userPrincipal(creator),
      disabled: agent ? false : creator.disabled,
      origin: { kind: 'thread', threadId: context.threadId, jobId: call.jobId, threadKind: context.kind ?? 'REPO', homeProject: context.project },
    };
    // Permissions P2 US-003: a thread tool call is the assistant acting for the requester, so the run is attributed
    // to `SYSTEM/assistant` with the requester as `onBehalfOf` — `actorTypeFor` then keeps every service the tool
    // calls (`FleetJobsService.dispatch` included) recording the requester's own type. The origin is the thread, so a
    // write is traceable to the call that came in rather than to a REST request.
    return runWithActionContext(
      { actor: ASSISTANT_ACTOR, onBehalfOf: { type: agent ? 'AGENT' : 'USER', id: creator.id }, origin: 'thread' },
      () => this.runAndStore(caller, call, tool, inputHash, started),
    );
  }

  /**
   * Non-thread callers have no replay key; every invocation gets its own audit row. An MCP call is the key holder's
   * own action, so it runs in a context whose actor is that principal and whose origin is `mcp` — even when the MCP
   * request already sits inside one (permissions P2 US-003). A thread-shaped caller runs in whatever context it
   * arrived with.
   */
  async executeFor(caller: ToolCaller, call: { name: string; input: unknown }): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) throw new NotFoundAppException({}, 'fleet.assistantTool');
    const run = (): Promise<ToolResult> =>
      this.runAndStore(caller, { ...call, jobId: null, toolCallId: null }, tool, sha256(stableStringify(call.input)), Date.now());
    if (caller.origin.kind !== 'mcp') return run();
    return runWithActionContext(
      { actor: { type: isAgentPrincipal(caller.principal) ? 'AGENT' : 'USER', id: caller.principal.id }, origin: 'mcp' },
      run,
    );
  }

  private async runAndStore(caller: ToolCaller, call: RunCall, tool: AssistantTool, inputHash: string, started: number): Promise<ToolResult> {
    const outcome = await this.run(call, tool, caller);
    const origin = caller.origin;
    const content = capText(outcome.content, RESULT_CAP_BYTES);
    const row: AssistantToolCallRecord = {
      actorType: isAgentPrincipal(caller.principal) ? 'agent' : 'user',
      actorId: caller.principal.id,
      jobId: call.jobId,
      threadId: origin.kind === 'thread' ? origin.threadId : null,
      projectId: outcome.projectId || (origin.kind === 'thread' ? origin.homeProject.id : null),
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
  private async run(call: RunCall, tool: AssistantTool, caller: ToolCaller): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    if (caller.disabled) return refusal('forbidden', 'forbidden: the thread creator is disabled');
    const origin = caller.origin;
    const workspace = origin.kind === 'mcp' || origin.threadKind === 'WORKSPACE';
    const workspaceTool = tool.scope === 'workspace';
    if (workspaceTool && !workspace) return refusal('invalid_input', `invalid_input: ${name} is only available in workspace threads`);
    if (hasProjectKey(call.input) && (!workspace || workspaceTool)) return refusal('invalid_input', 'invalid_input: project');
    const actor = caller.principal;
    if (workspaceTool) {
      const project = origin.kind === 'thread' ? origin.homeProject : { id: '', slug: '' };
      return this.execTool(call, tool, caller, { ...project, actor, input: call.input });
    }
    if (origin.kind === 'thread' && !workspace) return this.runInHomeProject(call, tool, caller, origin.homeProject);
    return this.runInNamedProject(call, tool, caller);
  }

  /** REPO and PROJECT threads retain parse-before-membership and their home project. */
  private async runInHomeProject(call: RunCall, tool: AssistantTool, caller: ToolCaller, project: { id: string; slug: string }): Promise<RunOutcome> {
    const parsed = parseInput(tool, call.input);
    if ('refusal' in parsed) return parsed.refusal;
    const { id, slug } = project;
    if ((await this.membership(id, caller.principal)) === undefined) return refusal('forbidden', `forbidden: ${tool.descriptor.name} needs project membership on ${slug}`);
    return this.execParsed(call, tool, caller, { id, slug, actor: caller.principal, input: parsed.value });
  }

  /** WORKSPACE and MCP callers resolve and authorize the explicit project before parsing tool input. */
  private async runInNamedProject(call: RunCall, tool: AssistantTool, caller: ToolCaller): Promise<RunOutcome> {
    const slug = projectArgument(call.input);
    if (slug === null) return refusal('invalid_input', 'invalid_input: project');
    const id = await this.findProject(slug);
    const resolved = id === undefined ? undefined : await this.membership(id, caller.principal);
    if (id === undefined || resolved === undefined) return refusal('not_found', 'not_found: project');
    const parsed = parseInput(tool, withoutProject(call.input));
    if ('refusal' in parsed) return { ...parsed.refusal, projectId: id };
    return this.execParsed(call, tool, caller, { id, slug, actor: caller.principal, input: parsed.value });
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

  /**
   * The creator's display role in the project, or undefined when they are not a member. Admissions still come
   * from it (a refusal is `undefined`), but US-004 stopped putting the role on the actor.
   */
  private async membership(projectId: string, actor: UserPrincipal | AgentPrincipal): Promise<string | null | undefined> {
    try {
      return await this.access.resolveMembership(projectId, actor);
    } catch (error) {
      if (error instanceof ForbiddenAppException) return undefined;
      throw error;
    }
  }

  /**
   * Permissions P1 US-004: the catalog-key check, for the caller's own principal, in the project the call acts in —
   * then the tool. The refusal names the tool, its key and the project slug; an implicit key is allowed by
   * `PermissionService.can` itself, so no tool has to special-case one.
   */
  private async execParsed(call: RunCall, tool: AssistantTool, caller: ToolCaller, scope: ToolScope): Promise<RunOutcome> {
    if (!(await this.can(scope.actor, tool.key, scope.id))) {
      return { ...refusal('forbidden', `forbidden: ${tool.descriptor.name} needs ${tool.key} on ${scope.slug}`), projectId: scope.id };
    }
    return this.execTool(call, tool, caller, scope);
  }

  /** Whether `actor` holds `key` in `projectId`; the one place the executor reads a permission decision. */
  private async can(actor: UserPrincipal | AgentPrincipal, key: string, projectId: string): Promise<boolean> {
    return (await this.permissions.can(actor, key, { projectId })).allowed;
  }

  private async execTool(call: RunCall, tool: AssistantTool, caller: ToolCaller, scope: ToolScope): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    const token = randomBytes(8).toString('hex');
    const ctx: ToolContext = {
      projectId: scope.id,
      projectSlug: scope.slug,
      actor: scope.actor,
      threadId: caller.origin.kind === 'thread' ? caller.origin.threadId : null,
      jobId: caller.origin.kind === 'thread' ? caller.origin.jobId : null,
      now: new Date(),
      data: (text) => fenceData(maskSecrets(text), token),
      can: (key) => this.can(scope.actor, key, scope.id),
    };
    if (tool.kind === 'write') return this.writeTool(call, tool, caller, scope, ctx);
    try {
      return { outcome: 'ok', content: await tool.execute(ctx, scope.input), projectId: scope.id };
    } catch (error) {
      if (error instanceof NotFoundAppException) return { ...refusal('not_found', 'not_found'), projectId: scope.id };
      this.logger.error(`koda tool ${name} failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
  }

  /** 3-D13/15: resolve policy once, after permission and before preview. Only none and thread-human are served. */
  private async writeTool(call: RunCall, tool: AssistantTool, caller: ToolCaller, scope: ToolScope, ctx: ToolContext): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    // Permissions P1 US-001: the caller's type decides the code default — a user's thread write waits for a human, an
    // agent's runs at once (and every MCP write runs at once, as before).
    const mode = approvalModeFor(caller.origin, name, isAgentPrincipal(caller.principal) ? 'agent' : 'user');
    if (mode !== 'none' && !(mode === 'human' && caller.origin.kind === 'thread')) {
      this.logger.error(`koda write tool ${name} refused approval mode ${mode} for ${caller.origin.kind}`);
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
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
      if (error instanceof ToolInputError) return { ...refusal('invalid_input', error.refusalText), projectId: scope.id };
      if (error instanceof ToolForbiddenError) {
        return { ...refusal('forbidden', `forbidden: ${name} needs ${error.need} on ${scope.slug}`), projectId: scope.id };
      }
      this.logger.error(`koda tool ${name} failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
    if (mode === 'none') return this.directWrite(call, tool, caller, scope, ctx, actions, preview);
    return this.proposeWrite(call, tool, caller, scope, ctx, actions, preview);
  }

  /** The existing human proposal path retains its thread, user and replay-key requirements. */
  private async proposeWrite(call: RunCall, tool: AssistantTool, caller: ToolCaller, scope: ToolScope, ctx: ToolContext, actions: ActionProposer, preview: string): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    const origin = caller.origin;
    if (origin.kind !== 'thread' || call.jobId === null || call.toolCallId === null || isAgentPrincipal(caller.principal)) {
      return { ...refusal('error', `error: ${name} failed`), projectId: scope.id };
    }
    const proposed = await actions.propose({
      projectId: scope.id,
      threadId: origin.threadId,
      threadKind: origin.threadKind,
      threadProjectSlug: origin.homeProject.slug,
      jobId: call.jobId,
      toolCallId: call.toolCallId,
      tool: name,
      // 2a-D3: `PendingAction.input` is the parsed input, and a write tool's parser answers a JSON object.
      input: scope.input as Record<string, unknown>,
      preview,
      actorId: caller.principal.id,
      now: ctx.now,
    });
    if ('refused' in proposed) return { ...refusal('refused', REFUSED_CONTENT), projectId: scope.id };
    return { ...refusal('pending', `pending ${proposed.actionId}: awaiting user approval; do not retry`), projectId: scope.id };
  }

  /** 3-D15: the write stands even if recording fails; never retry it or turn it into a proposal. */
  private async directWrite(call: RunCall, tool: AssistantTool, caller: ToolCaller, scope: ToolScope, ctx: ToolContext, actions: ActionProposer, preview: string): Promise<RunOutcome> {
    const name = tool.descriptor.name;
    let outcome: ToolCallOutcome = 'ok';
    let text: string;
    try {
      text = await tool.execute(ctx, scope.input);
    } catch (error) {
      outcome = error instanceof NotFoundAppException ? 'not_found' : 'error';
      if (error instanceof NotFoundAppException) text = 'not_found';
      else if (error instanceof ToolActionError) text = error.text;
      else {
        this.logger.error(`koda tool ${name} failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
        text = `error: ${name} failed`;
      }
    }
    text = capText(maskSecrets(text), RESULT_CAP_BYTES - 64);
    try {
      const { actionId } = await actions.recordDirect({
        projectId: scope.id,
        tool: name,
        input: scope.input,
        preview,
        actorType: isAgentPrincipal(caller.principal) ? 'agent' : 'user',
        actorId: caller.principal.id,
        origin: caller.origin.kind,
        status: outcome === 'ok' ? 'EXECUTED' : 'FAILED',
        result: text,
        now: ctx.now,
      });
      return { outcome, content: `${text}\naction ${actionId}`, projectId: scope.id };
    } catch (error) {
      this.logger.error(`koda tool ${name} action recording failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
      return { ...refusal('error', `error: ${name} failed (the change was made but its action was not recorded)`), projectId: scope.id };
    }
  }

  /**
   * Step 8: audit and store. A concurrent duplicate inside this process never reaches here with the same key (the
   * replay-key section above serializes it); a duplicate from another process loses on the `(jobId, toolCallId)`
   * unique constraint and answers the stored row instead.
   */
  private async store(row: AssistantToolCallRecord): Promise<ToolResult> {
    try {
      await this.calls.record(row);
    } catch (error) {
      if (row.jobId === null || row.toolCallId === null || !isUniqueViolation(error, 'toolCallId')) throw error;
      const winner = await this.calls.findByCall(row.jobId, row.toolCallId);
      if (!winner) throw error;
      return this.replay(winner, row.tool, row.inputHash);
    }
    return { content: row.content, isError: row.isError };
  }
}

type RunCall = { name: string; input: unknown; jobId: string | null; toolCallId: string | null };

/**
 * Permissions P2 US-003: a thread tool call, an approved action and an MCP call are all the assistant acting for
 * someone, so the run is attributed to this actor and the requester rides along as `onBehalfOf`. It is the
 * keyless `assistant` system id of `SYSTEM_ACTOR_IDS`.
 */
const ASSISTANT_ACTOR: ActionActor = Object.freeze({ type: 'SYSTEM', id: 'assistant' });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Permissions P2 US-003: the approval block an approved action carries — what policy demanded, how it was satisfied,
 * and who approved it. Before P3 sets a floor the only approval an assistant action carries is the approving human or
 * agent (`approvalMode`), and an action with no approver type records `satisfiedBy: 'none'` with no approver fields at
 * all: `approverType` and `approverId` are independently nullable, and an id without a type names nobody.
 */
function approvalFor(action: PendingActionRecord): ActionApproval {
  const approval: ActionApproval = {
    requiredMode: action.approvalMode,
    satisfiedBy: approverTier(action.approverType),
    requestId: action.id,
  };
  if (action.approverType !== null) {
    approval.approverType = action.approverType === 'user' ? 'USER' : 'AGENT';
    if (action.approverId !== null) approval.approverId = action.approverId;
  }
  return approval;
}

/** A USER approver is a human decision, an AGENT approver an agent one; no approver met no floor. */
function approverTier(approverType: 'user' | 'agent' | null): ApprovalMode {
  if (approverType === 'user') return 'human';
  if (approverType === 'agent') return 'agent';
  return 'none';
}

/** B1: the audit's replay key as a mutex key. The `/` separator keeps `('j1', 'c/1')` apart from `('j1/c', '1')`. */
const replayKey = (jobId: string, toolCallId: string): string => `${jobId}/${toolCallId}`;

const refusal = (outcome: ToolCallOutcome, content: string): RunOutcome => ({ outcome, content });

/** 2a-D4: the agent must not retry a write call the user has yet to decide, so `pending` is not an error. */
const isErrorOutcome = (outcome: ToolCallOutcome): boolean => outcome !== 'ok' && outcome !== 'pending';

/** Resolved project; absent falls back to the thread's home project, or null for MCP. */
interface RunOutcome {
  outcome: ToolCallOutcome;
  content: string;
  projectId?: string;
}

/** What a tool runs in: the project it acts on, the caller's principal, and the input its parser sees. */
interface ToolScope {
  id: string;
  slug: string;
  actor: UserPrincipal | AgentPrincipal;
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
    if (error instanceof ToolInputError) return { refusal: refusal('invalid_input', error.refusalText) };
    throw error;
  }
}

/** The creator acts with the principal their login would produce. No project role decorates it (permissions P1 US-004). */
export function userPrincipal(creator: UserToolCallCreator): UserPrincipal {
  const role = creator.role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
  return {
    actorType: 'user',
    id: creator.id,
    name: creator.email,
    email: creator.email,
    role,
    blacklisted: false,
    revoked: false,
    authorities: [role],
    extra: { sub: creator.id, email: creator.email, role },
  };
}

/** An absent (or non-AGENT) `type` is a user's, so every creator record written before this story still reads. */
const isAgentCreator = (creator: ToolCallCreator): creator is AgentToolCallCreator => creator.type === 'AGENT';

/**
 * Permissions P1 US-001: the agent requester acts as the agent its own API key would produce, with no roles or
 * capabilities of its own granted here — the tool's permission check decides what it may do, as for a user. A PAUSED
 * agent is blacklisted (the one status that removes access); `disabled` stays false because an agent's status is
 * liveness, not access.
 */
export function agentPrincipal(creator: AgentToolCallCreator): AgentPrincipal {
  return {
    actorType: 'agent',
    id: creator.id,
    name: creator.slug,
    slug: creator.slug,
    status: creator.status as KodaAgentStatus,
    capabilities: [],
    blacklisted: creator.status === 'PAUSED',
    revoked: false,
    authorities: [],
    extra: { slug: creator.slug },
  };
}
