import { describe, expect, it, vi } from 'vitest';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { CommentRouteCommands, COMMENT_ROUTE_VARIANTS } from './comment-route.commands';
import { CommentsService } from './comments.service';

const principal = { type: 'USER' as const, id: 'user-1' };

describe('CommentRouteCommands', () => {
  it('registers an executable comment deletion command', async () => {
    const registry = new ApprovalCommandRegistry();
    const comments = { delete: vi.fn().mockResolvedValue(undefined) };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const commands = new CommentRouteCommands(registry, comments as unknown as CommentsService, loader as unknown as ActorPrincipalLoader);

    commands.onModuleInit();

    const command = registry.get('comment.delete', COMMENT_ROUTE_VARIANTS.delete);
    expect(command).toBeDefined();
    expect(command?.parse({ id: 'c1', ignored: true })).toEqual({ id: 'c1' });
    await command?.execute({ id: 'c1' });
    expect(comments.delete).toHaveBeenCalledWith('c1', principal);
    expect(command?.toResult).toBeUndefined();
  });
});
