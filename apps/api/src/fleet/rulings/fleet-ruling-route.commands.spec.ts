import type { ApprovalCommand, ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetRulingRouteCommands } from './fleet-ruling-route.commands';

const principal: AgentPrincipal = { actorType: 'agent', id: 'agent', slug: 'ruler', status: 'ACTIVE', capabilities: [] };
const ruling = { itemId: 'D-1', text: 'confirm: green' };

function setup() {
  const rulings = {
    preflight: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ id: 'ruling', state: 'pending' })),
  };
  const commands = { register: vi.fn() } as unknown as ApprovalCommandRegistry;
  const loader = { forContext: vi.fn(async () => principal) } as unknown as ActorPrincipalLoader;
  new FleetRulingRouteCommands(commands, rulings as never, loader).onModuleInit();
  const command = vi.mocked(commands.register).mock.calls[0][0] as ApprovalCommand;
  const input = { slug: 'web', projectId: 'project', jobId: 'run', ruling };
  return { rulings, command, input };
}

describe('fleet ruling route command', () => {
  it('preflights then creates on the immediate path', async () => {
    const { rulings, command, input } = setup();
    await expect(command.execute(input)).resolves.toMatchObject({ id: 'ruling', state: 'pending' });
    expect(rulings.preflight).toHaveBeenCalledExactlyOnceWith('project', 'run', ruling);
    expect(rulings.create).toHaveBeenCalledExactlyOnceWith(principal, 'web', 'run', ruling);
  });

  it('F1: prepare runs the preflight, and the mutation it returns only creates', async () => {
    const { rulings, command, input } = setup();
    expect(command.prepare).toBeTypeOf('function');
    const mutate = await command.prepare?.(input, undefined);
    expect(rulings.preflight).toHaveBeenCalledExactlyOnceWith('project', 'run', ruling);
    expect(rulings.create).not.toHaveBeenCalled();
    await expect(mutate?.()).resolves.toMatchObject({ id: 'ruling', state: 'pending' });
    expect(rulings.create).toHaveBeenCalledExactlyOnceWith(principal, 'web', 'run', ruling);
    // The forge read happens once, in prepare: deferred execution must not repeat it under the row lock.
    expect(rulings.preflight).toHaveBeenCalledOnce();
  });

  it('F1: a preflight refusal in prepare throws instead of returning a mutation', async () => {
    const { rulings, command, input } = setup();
    const refusal = new Error('fleet.rulings.noItemIndex');
    rulings.preflight.mockRejectedValue(refusal);
    await expect(command.prepare?.(input, undefined)).rejects.toBe(refusal);
    expect(rulings.create).not.toHaveBeenCalled();
  });
});
