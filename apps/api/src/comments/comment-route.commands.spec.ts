import { describe, expect, it, vi } from 'vitest';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { CommentRouteCommands, COMMENT_ROUTE_VARIANTS } from './comment-route.commands';
import { CommentsService } from './comments.service';

const principal = { type: 'USER' as const, id: 'user-1' };

describe('CommentRouteCommands', () => {
  it('registers executable comment create and update commands', async () => {
    const registry = new ApprovalCommandRegistry();
    const comments = {
      create: vi.fn().mockResolvedValue({ id: 'c1' }),
      update: vi.fn().mockResolvedValue({ id: 'c1' }),
    };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const commands = new CommentRouteCommands(registry, comments as unknown as CommentsService, loader as unknown as ActorPrincipalLoader);
    commands.onModuleInit();

    const create = registry.get('comment.create', 'rest:comments.create');
    const update = registry.get('comment.update', 'rest:comments.update');
    expect(create).toBeDefined();
    expect(update).toBeDefined();
    expect(create?.parse({ slug: 'p', ref: 'P-1', comment: { body: 'hi' }, ignored: true })).toEqual({ slug: 'p', ref: 'P-1', comment: { body: 'hi' } });
    expect(update?.parse({ id: 'c1', patch: { body: 'x' }, ignored: true })).toEqual({ id: 'c1', patch: { body: 'x' } });
    await create?.execute({ slug: 'p', ref: 'P-1', comment: { body: 'hi' } });
    await update?.execute({ id: 'c1', patch: { body: 'x' } });
    expect(comments.create).toHaveBeenCalledWith('p', 'P-1', { body: 'hi' }, principal);
    expect(comments.update).toHaveBeenCalledWith('c1', { body: 'x' }, principal);
  });

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
