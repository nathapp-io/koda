import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { OutboxRouteCommands, OUTBOX_ROUTE_VARIANTS } from './outbox-route.commands';
import { AdminController } from './admin.controller';

describe('OutboxRouteCommands', () => {
  it('AC-9: registers, parses and executes retry with no stored result', async () => {
    const registry = new ApprovalCommandRegistry();
    const outbox = { retry: vi.fn().mockResolvedValue(undefined) };
    new OutboxRouteCommands(registry, outbox as never, { forContext: vi.fn().mockResolvedValue({ id: 'u1' }) } as never).onModuleInit();
    const command = registry.get('outbox.retry', OUTBOX_ROUTE_VARIANTS.retry);
    if (!command) throw new Error('Missing outbox command');
    expect(command).toMatchObject({ key: 'outbox.retry' });
    const input = command.parse({ eventId: 'dl-001', extra: 'discard' });
    expect(input).toEqual({ eventId: 'dl-001' });
    expect(await command.execute(input)).toBeNull();
    expect(command.toResult).toBeUndefined();
    expect(outbox.retry).toHaveBeenCalledExactlyOnceWith('dl-001');
    expect(() => command.parse({ eventId: '' })).toThrow();
  });
  it('AC-10: controller delegates retry to the global route gate', async () => {
    const gate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: null }) };
    const outbox = { retry: vi.fn() };
    const controller = new AdminController(outbox as never, gate as never);
    expect(await controller.retryOutboxEvent({ type: 'USER', id: 'u1' } as never, 'dl-001')).toBeUndefined();
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'outbox.retry', variant: 'rest:admin-outbox.retry', projectId: null, input: { eventId: 'dl-001' } });
    expect(outbox.retry).not.toHaveBeenCalled();
    gate.run.mockResolvedValue({ status: 'pending', request: { id: 'approval-1' } });
    await expect(controller.retryOutboxEvent({ id: 'u1' } as never, 'dl-001')).rejects.toBeInstanceOf(ApprovalPending);
  });
});
