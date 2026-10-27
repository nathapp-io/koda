import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { isAgentPrincipal } from '../../../auth/principal/koda-principal.types';
import { CommentsService } from '../../../comments/comments.service';
import { CommentType } from '../../../common/enums';
import { TicketsService } from '../../../tickets/tickets.service';
import { ASSISTANT_ACTION_REQUEST_REPOSITORY, type AssistantActionRequestRepository } from '../requests/assistant-action-request.domain';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_ADD_COMMENT, KODA_GET_ACTION } from '../koda-tool-descriptors';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { TICKET_REF } from './ticket-tools';
import { asRecord, ticketPath } from './tool-input';

/** The pilot write tool runs through ApprovalGate; the read reports a scoped approval request. */

/** 2a-D13: the longest comment body, measured after trim; the descriptor's `maxLength` carries the same number. */
const MAX_COMMENT_BODY_CHARS = 10_000;
/** 2a-D14: the longest action id; a longer one is malformed input, not a miss. */
const MAX_ACTION_ID_CHARS = 64;

interface AddCommentInput {
  ref: string;
  body: string;
}

interface GetActionInput {
  id: string;
}

/**
 * `koda_add_comment` (2a-D13): the comment one ticket of the thread's project should carry. `body` is kept as
 * written — only its trimmed length is judged — and the preview is the masked text the user approves.
 */
export function addCommentTool(deps: { tickets: TicketsService; comments: CommentsService }): AssistantTool<AddCommentInput> {
  return {
    descriptor: KODA_ADD_COMMENT,
    // Permissions P1 US-004: the catalog key the comment route enforces.
    key: 'comment.create',
    // 2a-D13: the comment route's own key; every built-in project role holds it.
    kind: 'write',
    parse(input: unknown): AddCommentInput {
      const raw = asRecord(input);
      const ref = raw['ref'];
      // The ref rule of `koda_get_ticket` (1b-D5): a ticket ref, never an arbitrary id.
      if (typeof ref !== 'string' || !TICKET_REF.test(ref)) throw new ToolInputError('ref');
      const body = raw['body'];
      if (typeof body !== 'string') throw new ToolInputError('body');
      const trimmed = body.trim();
      if (trimmed.length < 1 || trimmed.length > MAX_COMMENT_BODY_CHARS) throw new ToolInputError('body');
      return { ref, body };
    },
    /**
     * Step 2 of 2a-D2: the text the user is asked to approve. The ticket is read through the project-scoped
     * service, so a foreign or missing ref raises `NotFoundAppException` and the executor answers `not_found`
     * before any action exists.
     */
    async preview(ctx: ToolContext, input: AddCommentInput): Promise<string> {
      const ticket = await deps.tickets.findByRef(ctx.projectSlug, input.ref);
      return maskSecrets(`Add a comment to ${ticket.ref} "${ticket.title}":\n\n${input.body}`);
    },
    /** 2a-D13: what an approve runs. The comment is authored by the thread's creator, in the project they act in. */
    async execute(ctx: ToolContext, input: AddCommentInput): Promise<string> {
      const comment = await deps.comments.create(
        ctx.projectSlug,
        input.ref,
        { body: input.body, type: CommentType.GENERAL },
        ctx.actor,
      );
      return `comment ${comment.id} added to ${input.ref} ${ticketPath(ctx.projectSlug, input.ref)}`;
    },
  };
}

/**
 * `koda_get_action`: requests in the caller's project and thread, or its own requests over MCP.
 * An out-of-scope id and a missing id answer exactly the same `not_found`.
 */
export function getActionTool(links: Pick<AssistantActionRequestRepository, 'findScopedInThread' | 'findOwnRequest'>): AssistantTool<GetActionInput> {
  return {
    descriptor: KODA_GET_ACTION,
    // Permissions P1 US-004: implicit — every authenticated principal reads its own actions.
    key: 'assistant.action.read',
    parse(input: unknown): GetActionInput {
      const id = asRecord(input)['id'];
      if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ACTION_ID_CHARS) throw new ToolInputError('id');
      return { id };
    },
    async execute(ctx: ToolContext, input: GetActionInput): Promise<string> {
      if (ctx.threadId !== null) {
        const link = await links.findScopedInThread(input.id, ctx.projectId, ctx.threadId);
        if (!link) throw new NotFoundAppException({}, 'fleet.assistantAction');
        const request = link.request;
        const lines = [`action ${request.id} ${link.tool} ${request.status}`, `requested ${request.createdAt.toISOString()}`];
        if (request.decidedAt) lines.push(`decided ${request.decidedAt.toISOString()}`);
        if (request.settledAt) lines.push(`settled ${request.settledAt.toISOString()}`);
        if (request.result !== null && typeof request.result === 'object' && 'text' in request.result && typeof request.result.text === 'string') lines.push('result:', ctx.data(request.result.text));
        return lines.join('\n');
      }
      const request = await links.findOwnRequest(input.id, ctx.projectId, { type: isAgentPrincipal(ctx.actor) ? 'AGENT' : 'USER', id: ctx.actor.id });
      if (!request) throw new NotFoundAppException({}, 'fleet.assistantAction');
      const lines = [`action ${request.id} ${request.assistantAction?.tool ?? request.permissionKey} ${request.status}`, `requested ${request.createdAt.toISOString()}`];
      if (request.decidedAt) lines.push(`decided ${request.decidedAt.toISOString()}`);
      if (request.settledAt) lines.push(`settled ${request.settledAt.toISOString()}`);
      if (request.result !== null && typeof request.result === 'object' && 'text' in request.result && typeof request.result.text === 'string') lines.push('result:', ctx.data(request.result.text));
      return lines.join('\n');
    },
  };
}

/** The S5b 2a US-003 tool group: registers the action tools with the registry at bootstrap, like the other groups. */
@Injectable()
export class ActionTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly tickets: TicketsService,
    private readonly comments: CommentsService,
    @Inject(ASSISTANT_ACTION_REQUEST_REPOSITORY) private readonly links: AssistantActionRequestRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      getActionTool(this.links),
      addCommentTool({ tickets: this.tickets, comments: this.comments }),
    );
  }
}
