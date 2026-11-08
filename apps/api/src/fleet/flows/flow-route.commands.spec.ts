import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it, vi } from 'vitest';
import { parseFlowAnswers } from './flow-answers';
import {
  FLOW_ANSWER_VARIANT,
  FlowRouteCommands,
  THREAD_FLOW_CREATE_VARIANT,
  THREAD_PREAPPROVAL_ROUTE_VARIANTS,
} from './flow-route.commands';

function setup() {
  const commands = new Map<string, { parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }>();
  const registry = { register: vi.fn((command: { variant: string; parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }) => commands.set(command.variant, command)) };
  const threads = {
    setPreApproval: vi.fn().mockResolvedValue({ preApproval: { userId: 'user-1', at: '2026-01-01T00:00:00.000Z', costCapUsd: '30' } }),
    clearPreApproval: vi.fn().mockResolvedValue(false),
  };
  const user = { actorType: 'user', id: 'user-1' };
  const loader = { forContext: vi.fn().mockResolvedValue(user) };
  const flows = {
    create: vi.fn().mockResolvedValue({ flow: { id: 'flow-1' }, approvalRequestId: null }),
    answer: vi.fn().mockResolvedValue({ id: 'flow-1', state: 'RUNNING' }),
  };
  new FlowRouteCommands(registry as never, threads as never, loader as never, flows as never).onModuleInit();
  const command = (variant: string) => {
    const registered = commands.get(variant);
    if (!registered) throw new Error(`missing route command ${variant}`);
    return registered;
  };
  return { command, commands, registry, threads, user, loader, flows };
}

describe('FlowRouteCommands', () => {
  it('NAX AC-2/14: persisted NAX input reparses and delegates once as the requesting agent, without extra fields', async () => {
    const { command: getCommand, loader, flows } = setup();
    loader.forContext.mockResolvedValue({ actorType: 'agent', id: 'agent-1' });
    const command = getCommand('rest:fleet-nax-flow.create');
    const body = { remoteUrl: 'https://github.com/Org/Repo.git', branch: 'feat/flow-x', specSha: 'a'.repeat(40),
      features: [{ feature: 'flow-x', specPath: 'docs/spec.md' }], roles: { reviewer: 'reviewer', supervisor: 'supervisor' }, costCapUsd: 25 };
    const parsed = command.parse({ projectId: 'project-1', repoId: 'repo-1', body, token: 'must-not-persist' });
    const persisted: unknown = JSON.parse(JSON.stringify(parsed));
    expect(command.parse(persisted)).toEqual(parsed);
    expect(JSON.stringify(parsed)).not.toContain('must-not-persist');
    await command.execute(command.parse(persisted));
    expect(flows.create).toHaveBeenCalledOnce();
    expect(flows.create).toHaveBeenCalledWith({ entry: 'NAX', repoId: 'repo-1', branch: body.branch, specSha: body.specSha,
      features: [{ ...body.features[0], dependsOn: [] }], roles: body.roles, costCapUsd: '25' },
    { type: 'AGENT', id: 'agent-1' }, { projectId: 'project-1' });
  });
  it('F4: JSON-persisted parser output reparses and deferred execution creates the flow', async () => {
    const { command: registeredCommand, flows } = setup();
    const command = registeredCommand(THREAD_FLOW_CREATE_VARIANT);
    const first = command.parse({ projectId: 'project-1', threadId: 'thread-1', body: { features: [{ feature: 'flow-x', specPath: '.nax/features/flow-x/spec.md' }], roles: { reviewer: 'reviewer', supervisor: 'supervisor' }, costCapUsd: 25 } });
    const persisted = JSON.parse(JSON.stringify(first)) as unknown;
    const reparsed = command.parse(persisted);
    expect(reparsed).toEqual(first);
    await command.execute(reparsed);
    expect(flows.create).toHaveBeenCalledOnce();
  });

  it('AC-10: validates thread create body before execution can open an approval', async () => {
    const { command: registeredCommand, flows } = setup();
    const command = registeredCommand(THREAD_FLOW_CREATE_VARIANT);
    expect(() => command.parse({ projectId: 'project-1', threadId: 'thread-1', body: { features: [], roles: { reviewer: 'reviewer', supervisor: 'supervisor' }, costCapUsd: 25 } })).toThrow(ValidationAppException);
    expect(flows.create).not.toHaveBeenCalled();
  });

  it('AC-2: delegates thread create with the pinned project, thread, parsed body, and requesting principal', async () => {
    const { command: registeredCommand, commands, user, flows } = setup();
    const parsed = { features: [{ feature: 'flow-x', specPath: '.nax/features/flow-x/spec.md', dependsOn: [] }], roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25' };
    const create = flows.create;
    const command = registeredCommand(THREAD_FLOW_CREATE_VARIANT);
    const routeInput = { projectId: 'project-1', threadId: 'thread-1', body: parsed };
    expect(command.parse(routeInput)).toEqual({ projectId: 'project-1', threadId: 'thread-1', body: parsed });
    await command.execute(command.parse(routeInput));
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ entry: 'THREAD', threadId: 'thread-1', ...parsed }, { type: 'USER', id: user.id }, { projectId: 'project-1' });
    expect(commands.has(THREAD_FLOW_CREATE_VARIANT)).toBe(true);
  });
  it('AC-2: pins route project/thread and caller id in setPreApproval', async () => {
    const { command: registeredCommand, threads } = setup();
    const command = registeredCommand(THREAD_PREAPPROVAL_ROUTE_VARIANTS.set);
    const input = command.parse({ projectId: 'project-1', threadId: 'thread-1', costCapUsd: 30 });
    await command.execute(input);
    expect(threads.setPreApproval).toHaveBeenCalledOnce();
    expect(threads.setPreApproval).toHaveBeenCalledWith('project-1', 'thread-1', 'user-1', '30');
  });

  it('validates cost cap bounds and decimal precision', () => {
    const command = setup().command(THREAD_PREAPPROVAL_ROUTE_VARIANTS.set);
    for (const costCapUsd of [0, -1, 1000.0001, 1.23456, Number.NaN]) {
      expect(() => command.parse({ projectId: 'p', threadId: 't', costCapUsd })).toThrow(ValidationAppException);
    }
  });

  it('rechecks the actor when a deferred command executes', async () => {
    const { command: registeredCommand, threads, loader } = setup();
    loader.forContext.mockResolvedValue({ actorType: 'agent', id: 'agent-1' });
    const command = registeredCommand(THREAD_PREAPPROVAL_ROUTE_VARIANTS.set);
    await expect(command.execute(command.parse({ projectId: 'p', threadId: 't', costCapUsd: 30 })))
      .rejects.toBeInstanceOf(ForbiddenAppException);
    expect(threads.setPreApproval).not.toHaveBeenCalled();
  });

  it('clears idempotently through the service command', async () => {
    const { command: registeredCommand, threads } = setup();
    const command = registeredCommand(THREAD_PREAPPROVAL_ROUTE_VARIANTS.clear);
    await expect(command.execute(command.parse({ projectId: 'project-1', threadId: 'thread-1' }))).resolves.toBeNull();
    expect(threads.clearPreApproval).toHaveBeenCalledWith('project-1', 'thread-1');
  });

  it('AC-12: the answer command parses the route input and reparses its JSON round-trip to the same value', () => {
    const { command: registeredCommand, commands } = setup();
    const command = registeredCommand(FLOW_ANSWER_VARIANT);
    const body = { jobId: 'job-1', answers: [{ id: '2', answer: 'Clamp the bound' }] };
    const parsed = command.parse({ projectId: 'project-1', flowId: 'flow-1', body });
    expect(parsed).toEqual({ projectId: 'project-1', flowId: 'flow-1', body: parseFlowAnswers(body) });
    const persisted: unknown = JSON.parse(JSON.stringify(parsed));
    expect(command.parse(persisted)).toEqual(parsed);
    expect(commands.has(FLOW_ANSWER_VARIANT)).toBe(true);
  });

  it('AC-13: an agent principal is refused and the answer service is never called', async () => {
    const { command: registeredCommand, loader, flows } = setup();
    loader.forContext.mockResolvedValue({ actorType: 'agent', id: 'agent-1' });
    const command = registeredCommand(FLOW_ANSWER_VARIANT);
    const error = await command.execute(command.parse({
      projectId: 'project-1', flowId: 'flow-1', body: { jobId: 'job-1', answers: [{ id: '2', answer: 'A' }] },
    })).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect((error as ForbiddenAppException).prefix).toBe('fleet.flows.answerHumanOnly');
    expect((error as ForbiddenAppException).httpStatus).toBe(403);
    expect(flows.answer).not.toHaveBeenCalled();
  });

  it('AC-15: a user answers through the service with the parsed body and the caller identity', async () => {
    const { command: registeredCommand, flows, user } = setup();
    const command = registeredCommand(FLOW_ANSWER_VARIANT);
    const body = { jobId: 'job-1', answers: [{ id: '2', answer: 'Clamp the bound' }] };
    await command.execute(command.parse({ projectId: 'project-1', flowId: 'flow-1', body }));
    expect(flows.answer).toHaveBeenCalledOnce();
    expect(flows.answer).toHaveBeenCalledWith('project-1', 'flow-1', parseFlowAnswers(body), { type: 'USER', id: user.id });
  });
});
