import { randomBytes } from 'node:crypto';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { currentContext } from '../../../action-context/action-context';
import type { ApprovalCommand } from '../../../approvals/approval-command.registry';
import type { PermissionService } from '../../../permissions/permission.service';
import type { ProjectAccessService } from '../../../projects/project-access.service';
import type { AssistantToolCallRepository } from '../assistant-tool-call.domain';
import { agentPrincipal, userPrincipal, RESULT_CAP_BYTES } from '../assistant-tool.executor';
import { capText, fenceData, maskSecrets } from '../assistant-tool-safety';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';

export interface AssistantCommandInput {
  projectId: string;
  threadId: string | null;
  jobId: string | null;
  args: unknown;
}
export interface AssistantCommandResult { text: string }
export interface AssistantCommandDeps {
  calls: AssistantToolCallRepository;
  access: ProjectAccessService;
  permissions: PermissionService;
}
export class AssistantCommandRefusedError extends Error {
  constructor() { super('assistant-command-refused'); this.name = 'AssistantCommandRefusedError'; }
}

export function assistantToolCommand(tool: AssistantTool, deps: AssistantCommandDeps): ApprovalCommand<AssistantCommandInput, AssistantCommandResult> {
  const command: ApprovalCommand<AssistantCommandInput, AssistantCommandResult> = {
    key: tool.key,
    parse: (input) => parseCommandInput(input, tool),
    execute: (input) => runToolCommand(tool, input, deps),
    toResult: (result) => result,
  };
  const prepare = tool.kind === 'write' ? tool.prepare : undefined;
  if (prepare !== undefined) {
    // US-014 F1: the engine calls this before it opens the execution transaction, so a tool's external reads
    // (a forge call) never run under the approval row lock. Only the returned mutation runs inside it.
    command.prepare = async (input) => {
      const run = await toolRun(tool, input, deps);
      const mutate = await prepare(run.ctx, input.args);
      return async () => run.present(await mutate());
    };
  }
  return command;
}
function parseCommandInput(input: unknown, tool: AssistantTool): AssistantCommandInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolInputError('input');
  const raw = input as Record<string, unknown>;
  const { projectId, threadId, jobId } = raw;
  if (typeof projectId !== 'string' || projectId.length === 0) throw new ToolInputError('projectId');
  if (threadId !== null && typeof threadId !== 'string') throw new ToolInputError('threadId');
  if (jobId !== null && typeof jobId !== 'string') throw new ToolInputError('jobId');
  return { projectId, threadId: typeof threadId === 'string' ? threadId : null, jobId: typeof jobId === 'string' ? jobId : null, args: tool.parse(raw.args) };
}
/** A prepared tool run: the context a tool executes with, and the cap/mask the stored result goes through. */
interface ToolRun {
  ctx: ToolContext;
  present(text: string): AssistantCommandResult;
}
async function runToolCommand(tool: AssistantTool, input: AssistantCommandInput, deps: AssistantCommandDeps): Promise<AssistantCommandResult> {
  const run = await toolRun(tool, input, deps);
  return run.present(await tool.execute(run.ctx, input.args));
}
async function toolRun(tool: AssistantTool, input: AssistantCommandInput, deps: AssistantCommandDeps): Promise<ToolRun> {
  const context = currentContext();
  const actor = context?.actor.type === 'SYSTEM' && context.actor.id === 'assistant' ? context.onBehalfOf : context?.actor;
  if (!actor || (actor.type !== 'USER' && actor.type !== 'AGENT')) throw new AssistantCommandRefusedError();
  const record = actor.type === 'USER' ? await deps.calls.findUserActor(actor.id) : await deps.calls.findAgentActor(actor.id);
  if (!record || ('disabled' in record && record.disabled) || ('status' in record && record.status === 'PAUSED')) throw new AssistantCommandRefusedError();
  const principal = record.type === 'AGENT' ? agentPrincipal(record) : userPrincipal(record);
  try {
    await deps.access.resolveMembership(input.projectId, principal);
  } catch (error) {
    if (error instanceof ForbiddenAppException) throw new AssistantCommandRefusedError();
    throw error;
  }
  const projectSlug = await deps.calls.findProjectSlug(input.projectId);
  if (projectSlug === null) throw new NotFoundAppException({}, 'projects');
  const token = randomBytes(8).toString('hex');
  return {
    ctx: {
      projectId: input.projectId, projectSlug, actor: principal, threadId: input.threadId, jobId: input.jobId,
      now: new Date(), data: (text) => fenceData(maskSecrets(text), token),
      can: async (key) => (await deps.permissions.can(principal, key, { projectId: input.projectId })).allowed,
    },
    present: (text) => ({ text: capText(maskSecrets(text), RESULT_CAP_BYTES) }),
  };
}
