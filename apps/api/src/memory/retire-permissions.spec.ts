import { PERMISSION_CATALOG } from '../permissions/catalog';
import { SYSTEM_ROLES } from '../permissions/system-roles';

describe('decision retirement grants', () => {
  it('AC-1: declares project-only retirement', () => {
    expect(PERMISSION_CATALOG.find((entry) => entry.key === 'memory.decision.retire')?.scope).toBe('project');
  });
  it('AC-2: seeds developer retirement', () => {
    expect(SYSTEM_ROLES.find((role) => role.key === 'developer')?.permissions).toContain('memory.decision.retire');
  });
});
