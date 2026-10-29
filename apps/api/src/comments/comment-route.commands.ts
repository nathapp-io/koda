import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { parseBody } from '../approvals/route/parse-body';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

function routeBody(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  return Object.hasOwn(source, key) ? source[key] : {};
}

export const COMMENT_ROUTE_VARIANTS = {
  create: 'rest:comments.create',
  update: 'rest:comments.update',
  delete: 'rest:comments.delete',
} as const;

interface CommentCreateInput { slug: string; ref: string; comment: CreateCommentDto }
interface CommentUpdateInput { id: string; patch: UpdateCommentDto }
interface CommentDeleteInput { id: string }

@Injectable()
export class CommentRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly comments: CommentsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CommentCreateInput, Awaited<ReturnType<CommentsService['create']>>>({
      key: 'comment.create', variant: COMMENT_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug, ref } = parseRouteInput(input, ['slug', 'ref']);
        return { slug, ref, comment: parseBody(CreateCommentDto, routeBody(input, 'comment')) };
      },
      run: (principal, input) => this.comments.create(input.slug, input.ref, input.comment, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<CommentUpdateInput, Awaited<ReturnType<CommentsService['update']>>>({
      key: 'comment.update', variant: COMMENT_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        return { id, patch: parseBody(UpdateCommentDto, routeBody(input, 'patch')) };
      },
      run: (principal, input) => this.comments.update(input.id, input.patch, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<CommentDeleteInput, null>({
      key: 'comment.delete', variant: COMMENT_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => {
        await this.comments.delete(input.id, principal);
        return null;
      },
    }, this.loader));
  }
}
