import { findCatalogEntry } from './catalog';
import { SYSTEM_ROLES } from './system-roles';

describe('thread mode permissions', () => {
  it.each(['ask', 'full'])('mode %s is non-ownable, project scoped and high risk (AC-1/2)', (mode) => {
    expect(findCatalogEntry(`thread.mode.${mode}`)).toMatchObject({ scope: 'project', ownable: false, risk: 'high', approval: { approvable: true, floor: 'none', default: 'agent' } });
  });
  it('developer grants ask but never full (AC-3)', () => {
    const role = SYSTEM_ROLES.find((r) => r.key === 'developer');
    if (!role) throw new Error('Missing developer seed');
    expect(role.permissions).toContain('thread.mode.ask');
    expect(role.permissions).not.toContain('thread.mode.full');
  });
});
