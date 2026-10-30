import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';
import type { WebhookService } from './webhook.service';
import { WebhookRouteCommands, WEBHOOK_ROUTE_VARIANTS } from './webhook-route.commands';

describe('WebhookRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const service = {
      remove: vi.fn().mockResolvedValue(undefined),
      removeForProject: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ id: 'w1', projectId: 'p1', url: 'https://hooks.example/hook', secret: 'generated', events: '[]', active: true, createdAt: new Date(0) }),
      prepareCreate: vi.fn().mockResolvedValue(vi.fn()),
      update: vi.fn().mockResolvedValue({ id: 'w1', projectId: 'p1', url: 'https://hooks.example/hook', events: '[]', active: false, createdAt: new Date(0) }),
      prepareUpdate: vi.fn().mockResolvedValue(vi.fn()),
    };
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

  // ── US-004: the two secret-bearing writes behind the gate ─────────────────────────────────────

  type CreateInput = { slug: string; projectId: string; webhook: CreateWebhookDto };
  type UpdateInput = { slug: string; projectId: string; id: string; patch: UpdateWebhookDto };
  const createBody = { url: 'https://93.184.215.14/hook', events: ['ticket.created'] };

  const createCommand = (registry: ApprovalCommandRegistry) => {
    const command = registry.get('webhook.create', WEBHOOK_ROUTE_VARIANTS.create);
    if (!command) throw new Error('Missing webhook.create command');
    return command;
  };
  const updateCommand = (registry: ApprovalCommandRegistry) => {
    const command = registry.get('webhook.update', WEBHOOK_ROUTE_VARIANTS.update);
    if (!command) throw new Error('Missing webhook.update command');
    return command;
  };

  it('AC-9: registers create and update as redeem commands with a prepare step', () => {
    const { registry } = build();

    expect(WEBHOOK_ROUTE_VARIANTS.create).toBe('rest:project-webhooks.create');
    expect(WEBHOOK_ROUTE_VARIANTS.update).toBe('rest:project-webhooks.update');
    for (const command of [createCommand(registry), updateCommand(registry)]) {
      expect(command.prepare).toEqual(expect.any(Function));
      expect(command.redeem).toBeDefined();
    }
  });

  it('US-004: the create command parses, prepares and runs with the project identity', async () => {
    const { registry, service } = build();
    const command = createCommand(registry);
    const input = command.parse({ slug: 'alpha', projectId: 'p1', webhook: createBody, extra: 1 }) as CreateInput;

    expect(input).toEqual({ slug: 'alpha', projectId: 'p1', webhook: createBody });
    await command.prepare?.(input, undefined);
    expect(service.prepareCreate).toHaveBeenCalledExactlyOnceWith('p1', createBody);
    await command.execute(input);
    expect(service.create).toHaveBeenCalledExactlyOnceWith('p1', createBody);

    for (const value of [null, [], {}, { slug: 'alpha', projectId: 'p1' }, { slug: 'alpha', projectId: 'p1', webhook: { url: 'https://x.example' } }]) {
      expect(() => command.parse(value)).toThrow(ValidationAppException);
    }
  });

  it('US-004: the create redaction drops an absent secret and replaces a present one', async () => {
    const { registry } = build();
    const command = createCommand(registry);
    const redact = command.redeem?.redact;
    if (redact === undefined) throw new Error('Missing create redaction');

    const opened = redact({ slug: 'alpha', projectId: 'p1', webhook: createBody }) as CreateInput;
    expect(opened.webhook).not.toHaveProperty('secret');
    expect(opened).toEqual({ slug: 'alpha', projectId: 'p1', webhook: createBody });

    const withSecret = redact({ slug: 'alpha', projectId: 'p1', webhook: { ...createBody, secret: 's'.repeat(32) } }) as CreateInput;
    expect(withSecret.webhook.secret).toBe('<redacted>');
  });

  it('US-004: the create result drops the secret the call answered with', async () => {
    const { registry, service } = build();
    const command = createCommand(registry);
    const result = await command.execute({ slug: 'alpha', projectId: 'p1', webhook: createBody });

    expect(result).toMatchObject({ id: 'w1', secret: 'generated' });
    expect(command.toResult?.(result)).toEqual({
      id: 'w1', projectId: 'p1', url: 'https://hooks.example/hook', events: '[]', active: true, createdAt: new Date(0),
    });
    expect(service.create).toHaveBeenCalledOnce();
  });

  it('US-004: the update command parses, prepares and runs with the webhook id', async () => {
    const { registry, service } = build();
    const command = updateCommand(registry);
    const input = command.parse({ slug: 'alpha', projectId: 'p1', id: 'w1', patch: { active: false } }) as UpdateInput;

    expect(input).toEqual({ slug: 'alpha', projectId: 'p1', id: 'w1', patch: { active: false } });
    await command.prepare?.(input, undefined);
    expect(service.prepareUpdate).toHaveBeenCalledExactlyOnceWith('p1', 'w1', input.patch);
    await command.execute(input);
    expect(service.update).toHaveBeenCalledExactlyOnceWith('p1', 'w1', input.patch);
    expect(command.toResult?.(await command.execute(input))).toMatchObject({ id: 'w1', active: false });

    for (const value of [null, [], {}, { slug: 'alpha', projectId: 'p1', patch: {} }, { slug: 'alpha', projectId: 'p1', id: 'w1', patch: { active: 'no' } }]) {
      expect(() => command.parse(value)).toThrow(ValidationAppException);
    }
  });

  it('US-004: the update redaction drops an absent secret and replaces a present one', async () => {
    const { registry } = build();
    const redact = updateCommand(registry).redeem?.redact;
    if (redact === undefined) throw new Error('Missing update redaction');

    const opened = redact({ slug: 'alpha', projectId: 'p1', id: 'w1', patch: { active: false } }) as UpdateInput;
    expect(opened.patch).not.toHaveProperty('secret');
    expect(opened).toEqual({ slug: 'alpha', projectId: 'p1', id: 'w1', patch: { active: false } });

    const withSecret = redact({ slug: 'alpha', projectId: 'p1', id: 'w1', patch: { secret: 's'.repeat(32) } }) as UpdateInput;
    expect(withSecret.patch.secret).toBe('<redacted>');
  });
});
