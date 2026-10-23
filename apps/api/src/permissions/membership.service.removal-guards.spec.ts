import type { AppException } from '@nathapp/nestjs-common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { AfterCommitService } from './after-commit.service';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import type { Granter } from './permissions.types';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * Permissions P1 US-001 and US-002 — the removal guards of `MembershipService.removeBinding` without a
 * database: the project-members and project-agents advisory locks, the last-active-Project-Admin
 * refusal, its override, the agent's open-ticket refusal, and the step order that keeps them under the
 * lock. The integration suite runs the HTTP criteria against Postgres; this file pins the service's own
 * contract.
 */

const BY: Granter = { type: 'SYSTEM', id: 'test' };
const USER = (id: string) => ({ type: 'USER' as const, id });
const AGENT = (id: string) => ({ type: 'AGENT' as const, id });

/** A transaction manager double that runs the callback immediately, outside any transaction. */
const immediateTx = () => ({
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  isInTransaction: () => false,
});

describe('MembershipService.removeBinding removal guards (US-001)', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let bindings: ReturnType<InMemoryPermissionStore['bindingRepo']>;
  let service: MembershipService;

  const create = (principalId: string, roleKey: string, projectId: string | null) =>
    service.createBinding({ principal: USER(principalId), roleKey, projectId }, BY);

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    bindings = store.bindingRepo();
    service = new MembershipService(
      store.roleRepo() as never,
      bindings as never,
      immediateTx() as never,
      new PermissionCache(cache as never),
      cache as never,
      new AfterCommitService(),
    );
    store.addUser('u1');
    store.addUser('u2');
    store.projects.add('p1');
    store.projects.add('p2');
  });

  describe('AC-11: the project-members lock', () => {
    it('records lockProjectMembers for the project before lockUser for the binding\'s user', async () => {
      const kept = await create('u2', 'project-admin', 'p1');
      const removed = await create('u1', 'project-admin', 'p1');
      expect(kept.id).not.toBe(removed.id);
      store.calls.length = 0;

      await service.removeBinding(removed.id);

      const projectLock = store.calls.indexOf('lock-project-members:p1');
      const userLock = store.calls.indexOf('lock-user:u1');
      expect(projectLock).toBeGreaterThanOrEqual(0);
      expect(userLock).toBeGreaterThanOrEqual(0);
      expect(projectLock).toBeLessThan(userLock);
    });

    it('takes no project lock for a binding that is not a project admin\'s', async () => {
      await create('u2', 'project-admin', 'p1');
      const developer = await create('u1', 'developer', 'p1');
      store.calls.length = 0;

      await service.removeBinding(developer.id);

      expect(store.calls.some((call) => call.startsWith('lock-project-members:'))).toBe(false);
    });
  });

  describe('the last active Project Admin refusal', () => {
    it('refuses the removal with 409 members.lastAdmin and keeps the binding', async () => {
      const binding = await create('u1', 'project-admin', 'p1');

      const error = await service.removeBinding(binding.id).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect((error as AppException).prefix).toBe('members.lastAdmin');
      expect((error as AppException).httpStatus).toBe(409);
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });

    it('removes the binding while a second enabled project admin remains', async () => {
      await create('u2', 'project-admin', 'p1');
      const binding = await create('u1', 'project-admin', 'p1');

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('removes the only project-admin binding when its user is disabled', async () => {
      store.addUser('off', true);
      const binding = await create('off', 'project-admin', 'p1');

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('removes the last project admin when the caller passes the override', async () => {
      const binding = await create('u1', 'project-admin', 'p1');

      await expect(
        service.removeBinding(binding.id, { lastProjectAdminOverride: true }),
      ).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('counts only the binding\'s own project', async () => {
      await create('u2', 'project-admin', 'p2');
      const binding = await create('u1', 'project-admin', 'p1');

      const error = await service.removeBinding(binding.id).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(store.calls).toContain('count-active-project-admins:p1');
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });
  });

  describe('AC-12: a binding whose user row is gone', () => {
    it('treats it as inactive and resolves without consulting the active-admin count', async () => {
      const binding = store.bind(USER('ghost'), 'project-admin', 'p1');
      // A canary: the count would fail loudly, so a guard that reached it could not resolve.
      store.activeAdminCountFailure = new Error('countActiveProjectAdmins ran for a missing user row');
      store.calls.length = 0;

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
      expect(store.calls).not.toContain('count-active-project-admins:p1');
    });
  });

  describe('AC-13: the active-admin count fails', () => {
    it('propagates the error and leaves the binding in place', async () => {
      const binding = await create('u1', 'project-admin', 'p1');
      const failure = new Error('countActiveProjectAdmins failed');
      store.activeAdminCountFailure = failure;

      await expect(service.removeBinding(binding.id)).rejects.toBe(failure);

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });
  });

  describe('AC-14: an unknown id without options', () => {
    it('still answers 404 permissions.bindingNotFound before taking any lock', async () => {
      store.calls.length = 0;

      const error = await service.removeBinding('missing-binding').catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect(JSON.stringify(error)).toContain('permissions.bindingNotFound');
      expect(store.calls).toEqual([]);
    });
  });
});

/**
 * US-002 — the agent project lock and the open-ticket guard. An agent's bindings are projected on
 * `store.agents`/`store.bindings` directly: the guard reads them, not a service call.
 */
describe('MembershipService.removeBinding open-ticket guard (US-002)', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let service: MembershipService;

  const agentBinding = (agentId: string, roleKey: string, projectId: string | null) => {
    store.agents.add(agentId);
    return store.bind(AGENT(agentId), roleKey, projectId);
  };

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    service = new MembershipService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      immediateTx() as never,
      new PermissionCache(cache as never),
      cache as never,
      new AfterCommitService(),
    );
    store.projects.add('p1');
    store.projects.add('p2');
  });

  describe('AC-7: the project-agents lock', () => {
    it('records lockProjectAgents for the binding\'s project', async () => {
      const binding = agentBinding('a1', 'viewer', 'p1');
      store.calls.length = 0;

      await service.removeBinding(binding.id);

      expect(store.calls).toContain('lock-project-agents:p1');
    });

    it('takes the project-agents lock before reading the bindings it guards', async () => {
      const binding = agentBinding('a1', 'viewer', 'p1');
      store.calls.length = 0;

      await service.removeBinding(binding.id);

      const agentsLock = store.calls.indexOf('lock-project-agents:p1');
      const otherBindings = store.calls.indexOf('count-other-project-bindings:AGENT:a1:p1');
      const openTickets = store.calls.indexOf('count-open-agent-tickets:a1:p1');
      expect(agentsLock).toBeGreaterThanOrEqual(0);
      expect(otherBindings).toBeGreaterThan(agentsLock);
      expect(openTickets).toBeGreaterThan(otherBindings);
    });

    it('takes no project-agents lock for a binding outside any project', async () => {
      const binding = agentBinding('a1', 'agent', null);
      store.calls.length = 0;

      await service.removeBinding(binding.id);

      expect(store.calls.some((call) => call.startsWith('lock-project-agents:'))).toBe(false);
    });

    it('takes no project-agents lock for a user binding, even an agent-roster one', async () => {
      store.addUser('u1');
      const binding = store.bind(USER('u1'), 'viewer', 'p1');
      store.calls.length = 0;

      await service.removeBinding(binding.id);

      expect(store.calls.some((call) => call.startsWith('lock-project-agents:'))).toBe(false);
    });
  });

  describe('AC-8: the open-ticket count fails', () => {
    it('rejects with that error and leaves the binding in place', async () => {
      const binding = agentBinding('a1', 'viewer', 'p1');
      const failure = new Error('countOpenAgentTickets failed');
      store.openAgentTicketsFailure = failure;

      await expect(service.removeBinding(binding.id)).rejects.toBe(failure);

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });
  });

  describe('the open-ticket refusal', () => {
    it('refuses the last binding in P with the count and the refs of the open tickets', async () => {
      const binding = agentBinding('a1', 'viewer', 'p1');
      store.openAgentTickets.set('a1:p1', { count: 2, refs: ['P1-7', 'P1-9'] });

      const error = await service.removeBinding(binding.id).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect((error as AppException).prefix).toBe('projectAgents.hasOpenTickets');
      expect((error as AppException).httpStatus).toBe(409);
      expect((error as AppException).args).toEqual({ count: 2, refs: 'P1-7, P1-9' });
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });

    it('removes the binding while the agent holds another binding in the same project', async () => {
      const kept = agentBinding('a1', 'viewer', 'p1');
      const binding = agentBinding('a1', 'developer', 'p1');
      expect(kept.id).not.toBe(binding.id);
      store.openAgentTickets.set('a1:p1', { count: 2, refs: ['P1-7', 'P1-9'] });

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('removes the last binding in P when the agent holds no open ticket there', async () => {
      const binding = agentBinding('a1', 'viewer', 'p1');

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('refuses the last PROJECT-scope binding in P although the agent holds a projectId-null one', async () => {
      agentBinding('a1', 'viewer', null);
      const binding = agentBinding('a1', 'viewer', 'p1');
      store.openAgentTickets.set('a1:p1', { count: 1, refs: ['P1-7'] });

      const error = await service.removeBinding(binding.id).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });

    it('counts open tickets in the binding\'s own project only', async () => {
      const binding = agentBinding('a1', 'viewer', 'p1');
      store.openAgentTickets.set('a1:p2', { count: 3, refs: ['P2-1'] });
      store.calls.length = 0;

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.calls).toContain('count-open-agent-tickets:a1:p1');
      expect(store.calls).not.toContain('count-open-agent-tickets:a1:p2');
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });
  });
});
