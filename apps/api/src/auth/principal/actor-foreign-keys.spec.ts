import { actorForeignKeys } from './actor-foreign-keys';
import { actorKind } from './koda-principal.types';
import type { RunnerPrincipal } from './koda-principal.types';

it('refuses to derive ticket/comment actor columns for a runner', () => {
  const runner = { actorType: 'runner', id: 'r1', name: 'r', runnerName: 'r', labels: [], enabled: true, capacity: 1, blacklisted: false, revoked: false, authorities: [] } as RunnerPrincipal;
  expect(() => actorForeignKeys(runner, 'createdBy')).toThrow('runner principals cannot author domain records');
});

it('actorKind maps users and agents and refuses runners', () => {
  const runner = { actorType: 'runner', id: 'r1', name: 'r', runnerName: 'r', labels: [], enabled: true, capacity: 1, blacklisted: false, revoked: false, authorities: [] } as RunnerPrincipal;
  expect(actorKind({ actorType: 'user' } as never)).toBe('user');
  expect(actorKind({ actorType: 'agent' } as never)).toBe('agent');
  expect(() => actorKind(runner)).toThrow('runner principals cannot author domain records');
});
