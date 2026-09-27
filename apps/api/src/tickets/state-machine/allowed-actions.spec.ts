import { canOverrideClose } from './allowed-actions';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';

const user = (over: Partial<UserPrincipal> = {}): UserPrincipal => ({
  actorType: 'user', id: 'u1', name: 'u1', email: 'u1@x', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'], ...over,
});
const agent: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'bot', slug: 'bot', status: 'ACTIVE',
  agentRoles: ['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'], capabilities: [],
  blacklisted: false, revoked: false, authorities: ['WORKER'],
};

describe('canOverrideClose', () => {
  it.each([
    ['global ADMIN', user({ role: 'ADMIN' }), true],
    ['project ADMIN', user({ projectRole: 'ADMIN' }), true],
    ['project DEVELOPER', user({ projectRole: 'DEVELOPER' }), false],
    ['project VIEWER', user({ projectRole: 'VIEWER' }), false],
    ['no project role', user(), false],
    ['agent with every role', agent, false],
  ])('%s -> %s', (_label, principal, expected) => {
    expect(canOverrideClose(principal)).toBe(expected);
  });
});
