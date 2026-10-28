import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { WebhookService } from './webhook.service';
import { WebhookRouteCommands, WEBHOOK_ROUTE_VARIANTS } from './webhook-route.commands';

describe('WebhookRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const service = { remove: vi.fn().mockResolvedValue(undefined), removeForProject: vi.fn().mockResolvedValue(undefined) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new WebhookRouteCommands(registry, service as unknown as WebhookService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, service, loader };
  }
  it.each([
    ['projectDelete', 'rest:project-webhooks.delete', { projectId: 'p1', id: 'w1' }, 'removeForProject', ['p1', 'w1']],
    ['globalDelete', 'rest:webhooks.delete', { id: 'w1' }, 'remove', ['w1']],
  ] as const)('AC-11: registers and runs %s without a result mapper', async (name, variant, input, method, args) => {
    const { registry, service, loader } = build();
    expect(WEBHOOK_ROUTE_VARIANTS[name]).toBe(variant);
    const command = registry.get('webhook.delete', variant);
    expect(command).toBeDefined();
    if (!command) throw new Error('Missing command');
    expect(command.parse({ ...input, extra: 1 })).toEqual(input);
    expect(await command.execute(command.parse(input))).toBeNull();
    expect(service[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(command.toResult).toBeUndefined();
    for (const value of [null, [], {}, { id: '' }, { id: 3 }]) expect(() => command.parse(value)).toThrow(ValidationAppException);
  });
  it('preserves the cross-project NotFound failure from removeForProject', async () => {
    const { registry, service } = build();
    const error = new NotFoundAppException({}, 'webhooks');
    service.removeForProject.mockRejectedValue(error);
    const command = registry.get('webhook.delete', WEBHOOK_ROUTE_VARIANTS.projectDelete);
    if (!command) throw new Error('Missing project delete command');
    await expect(command.execute({ projectId: 'p1', id: 'other' })).rejects.toBe(error);
  });
});
