import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { isAgentPrincipal } from '../../../auth/principal/koda-principal.types';
import { CommentsService } from '../../../comments/comments.service';
import { CommentType } from '../../../common/enums';
import { TicketsService } from '../../../tickets/tickets.service';
import { PENDING_ACTION_REPOSITORY, type ActionStatusView, type PendingActionRepository } from '../actions/pending-action.domain';
import { ASSISTANT_ACTION_REQUEST_REPOSITORY, type AssistantActionRequestRepository } from '../requests/assistant-action-request.domain';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_ADD_COMMENT, KODA_GET_ACTION } from '../koda-tool-descriptors';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { TICKET_REF } from './ticket-tools';
import { asRecord, ticketPath } from './tool-input';

/**
 * Fleet S5b 2a US-003 (2a-D13, 2a-D14): the pilot write tool and the read that reports on it. `koda_add_comment`
 * never posts anything itself — the executor previews it, the propose service stores the action and the user decides
 * it (2a-D2) — so `execute` is what an approve runs. `koda_get_action` answers one action of the calling thread.
 */

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
 * `koda_get_action` (2a-D14): one action's status, as the lines the spec fixes. The scope is part of the read — the
 * caller's own project and its own thread — so an id of another thread (in this project or another) and an id that
 * does not exist answer exactly the same `not_found`.
 */
export function getActionTool(actions: Pick<PendingActionRepository, 'findScopedById' | 'findScopedByActor'>, links: Pick<AssistantActionRequestRepository, 'findScopedInThread'>): AssistantTool<GetActionInput> {
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
      const action = await actions.findScopedByActor(input.id, ctx.projectId, { type: isAgentPrincipal(ctx.actor) ? 'agent' : 'user', id: ctx.actor.id });
      if (!action) throw new NotFoundAppException({}, 'fleet.assistantAction');
      return actionLines(ctx, action).join('\n');
    },
  };
}

/** 2a-D14: `action <id> <tool> <status>`, when it was asked for, when it was decided and its result. */
function actionLines(ctx: ToolContext, action: ActionStatusView): string[] {
  const lines = [`action ${action.id} ${action.tool} ${action.status}`, `requested ${action.createdAt.toISOString()}`];
  if (action.decidedAt) lines.push(`decided ${action.decidedAt.toISOString()}`);
  if (action.result !== null) lines.push('result:', ctx.data(action.result));
  return lines;
}

/** The S5b 2a US-003 tool group: registers the action tools with the registry at bootstrap, like the other groups. */
@Injectable()
export class ActionTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly tickets: TicketsService,
    private readonly comments: CommentsService,
    @Inject(PENDING_ACTION_REPOSITORY) private readonly actions: PendingActionRepository,
    @Inject(ASSISTANT_ACTION_REQUEST_REPOSITORY) private readonly links: AssistantActionRequestRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      getActionTool(this.actions, this.links),
      addCommentTool({ tickets: this.tickets, comments: this.comments }),
    );
  }
}
