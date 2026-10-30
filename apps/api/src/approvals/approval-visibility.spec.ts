import { visibleRequestWhere } from './approval-visibility';
import type { DecideScopes } from '../permissions/permission.service';

const principal = { type: 'AGENT' as const, id: 'caller' };
const own = [
  { actorType: 'AGENT', actorId: 'caller' },
  { onBehalfOfType: 'AGENT', onBehalfOfId: 'caller' },
];
const admin: DecideScopes = { everywhere: true, global: 'all', projects: [] };

describe('visibleRequestWhere', () => {
  it('AC-7: unrestricted pending visibility has no OR', () => {
    expect(visibleRequestWhere({ principal, scopes: admin }, { status: 'pending' })).toEqual({ status: 'pending' });
  });
  it('AC-8: project decide visibility includes actor and on-behalf-of', () => {
    expect(visibleRequestWhere({ principal, scopes: { everywhere: false, global: [], projects: [{ projectId: 'p1', patterns: 'all' }] } }, {}))
      .toEqual({ OR: [...own, { projectId: 'p1' }] });
  });
  it('AC-9: mine excludes even unrestricted decide visibility', () => {
    expect(visibleRequestWhere({ principal, scopes: admin }, { mine: true })).toEqual({ OR: own });
  });
  it('preserves exact and wildcard global and project patterns', () => {
    expect(visibleRequestWhere({ principal, scopes: { everywhere: false, global: ['role.manage', 'label.*'], projects: [{ projectId: 'p1', patterns: ['ticket.delete', 'agent.*'] }] } }, {}))
      .toEqual({ OR: [...own, { permissionKey: 'role.manage' }, { permissionKey: { startsWith: 'label.' } }, { projectId: 'p1', permissionKey: 'ticket.delete' }, { projectId: 'p1', permissionKey: { startsWith: 'agent.' } }] });
  });
  it('ANDs job and other filters with visibility', () => {
    expect(visibleRequestWhere({ principal, scopes: { everywhere: false, global: [], projects: [] } }, { jobId: 'j', projectId: 'p', permissionKey: 'agent.create', status: 'pending' }))
      .toEqual({ status: 'pending', projectId: 'p', permissionKey: 'agent.create', fleetAsk: { is: { jobId: 'j' } }, OR: own });
  });
  it('a global all grant is unrestricted without everywhere', () => {
    expect(visibleRequestWhere({ principal, scopes: { everywhere: false, global: 'all', projects: [] } }, {})).toEqual({});
  });
});
