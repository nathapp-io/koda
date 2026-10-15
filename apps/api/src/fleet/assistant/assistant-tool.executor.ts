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
import { capText, fenceData, maskSecrets } from './assistant-tool-safety';
import { ASSISTANT_TOOL_CALL_REPOSITORY, type AssistantToolCallRecord, type AssistantToolCallRepository, type ToolCallContext, type ToolCallOutcome } from './assistant-tool-call.domain';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { ToolInputError, type AssistantTool, type ToolContext, type ToolResult } from './assistant-tool.types';

/** The most bytes of one tool result the agent reads (S5b-R5). */
const RESULT_CAP_BYTES = 16_384;

export interface ToolCall {
  jobId: string;
  toolCallId: string;
  name: string;
  input: unknown;
}

/** Fleet S5b §1 (US-002): runs a koda tool for the thread's creator, with the permission the creator would have in the web. */
@Injectable()
export class AssistantToolExecutor {
  private readonly logger = new Logger(AssistantToolExecutor.name);

  constructor(
    private readonly registry: AssistantToolRegistry,
    @Inject(ASSISTANT_TOOL_CALL_REPOSITORY) private readonly calls: AssistantToolCallRepository,
    private readonly access: ProjectAccessService,
    private readonly abilities: KodaCaslAbilityFactory,
  ) {}

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
      projectId: context.project.id,
      toolCallId: call.toolCallId,
      tool: call.name,
      inputHash,
      outcome: outcome.outcome,
      content,
      isError: outcome.outcome !== 'ok',
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

  /** Steps 3 to 6: context, parse, permission, execute. Every refusal is data for the agent. */
  private async run(call: ToolCall, tool: AssistantTool, context: ToolCallContext): Promise<{ outcome: ToolCallOutcome; content: string }> {
    const name = tool.descriptor.name;
    const slug = context.project.slug;
    if (context.creator.disabled) return refusal('forbidden', 'forbidden: the thread creator is disabled');

    const actor = userPrincipal(context.creator);
    let input: unknown;
    try {
      input = tool.parse(call.input);
    } catch (error) {
      if (error instanceof ToolInputError) return refusal('invalid_input', `invalid_input: ${error.reason}`);
      throw error;
    }

    let role: string | null;
    try {
      role = await this.access.resolveMembership(context.project.id, actor);
    } catch (error) {
      if (error instanceof ForbiddenAppException) return refusal('forbidden', `forbidden: ${name} needs project membership on ${slug}`);
      throw error;
    }
    const scoped = withProjectRole(actor, role) as UserPrincipal;
    if (tool.permission.kind === 'ability') {
      const { action, subject: target } = tool.permission;
      const ability = await this.abilities.createForUser(scoped);
      if (!ability.can(action as CaslPermissionAction, subject(target, {}))) return refusal('forbidden', `forbidden: ${name} needs ${action} ${target} on ${slug}`);
    }

    const token = randomBytes(8).toString('hex');
    const ctx: ToolContext = {
      projectId: context.project.id,
      projectSlug: slug,
      actor: scoped,
      threadId: context.threadId,
      jobId: call.jobId,
      now: new Date(),
      data: (text) => fenceData(maskSecrets(text), token),
    };
    try {
      return { outcome: 'ok', content: await tool.execute(ctx, input) };
    } catch (error) {
      if (error instanceof NotFoundAppException) return refusal('not_found', 'not_found');
      this.logger.error(`koda tool ${name} failed for job ${call.jobId}`, error instanceof Error ? error.stack : String(error));
      return refusal('error', `error: ${name} failed`);
    }
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

const refusal = (outcome: ToolCallOutcome, content: string) => ({ outcome, content });

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
