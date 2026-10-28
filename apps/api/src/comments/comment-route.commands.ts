import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { CommentsService } from './comments.service';

export const COMMENT_ROUTE_VARIANTS = {
  delete: 'rest:comments.delete',
} as const;

interface CommentDeleteInput {
  id: string;
}

@Injectable()
export class CommentRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly comments: CommentsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CommentDeleteInput, null>({
      key: 'comment.delete',
      variant: COMMENT_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => {
        await this.comments.delete(input.id, principal);
        return null;
      },
    }, this.loader));
  }
}
