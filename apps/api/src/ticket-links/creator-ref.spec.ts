import { creatorRef } from './creator-ref';
import type { AgentPrincipal, UserPrincipal, RunnerPrincipal } from '../auth/principal/koda-principal.types';

describe('creatorRef', () => {
  it('AC-12: preserves the agent id', () => {
    expect(creatorRef({ actorType: 'agent', id: 'a1' } as AgentPrincipal)).toEqual({ type: 'AGENT', id: 'a1' });
  });
  it('AC-12: preserves the user id', () => {
    expect(creatorRef({ actorType: 'user', id: 'u1' } as UserPrincipal)).toEqual({ type: 'USER', id: 'u1' });
  });
  it('does not attribute a link to a runner', () => {
    expect(creatorRef({ actorType: 'runner', id: 'r1' } as RunnerPrincipal)).toBeUndefined();
  });
});
