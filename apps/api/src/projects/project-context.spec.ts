import { withProjectRole } from './project-context';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

const user: UserPrincipal = {
  actorType: 'user', id: 'u1', name: 'u1', email: 'u1@x', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'],
};
const agent: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'bot', slug: 'bot', status: 'ACTIVE',
  agentRoles: ['DEVELOPER'], capabilities: [], blacklisted: false, revoked: false, authorities: ['WORKER'],
};

describe('withProjectRole', () => {
  it('returns a new user principal carrying the project role, without mutating the input', () => {
    const enriched = withProjectRole(user, 'DEVELOPER');
    expect(enriched).toEqual({ ...user, projectRole: 'DEVELOPER' });
    expect(enriched).not.toBe(user);
    expect(user).not.toHaveProperty('projectRole');
  });

  it('overrides a projectRole already present on the input (never trusts a prior value)', () => {
    expect(withProjectRole({ ...user, projectRole: 'ADMIN' }, 'VIEWER')).toEqual({ ...user, projectRole: 'VIEWER' });
  });

  it('returns agents unchanged', () => {
    expect(withProjectRole(agent, 'ADMIN')).toBe(agent);
  });

  it('returns the user unchanged when there is no role (route outside a project)', () => {
    expect(withProjectRole(user, null)).toBe(user);
  });
});
