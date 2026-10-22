import type { RoleDomain } from '../permissions.types';
import { RoleDto } from './role.dto';

const role = (overrides: Partial<RoleDomain> = {}): RoleDomain => ({
  id: 'role-1',
  key: 'qa',
  name: 'QA',
  description: '',
  scope: 'PROJECT',
  system: false,
  locked: false,
  permissions: ['ticket.read'],
  ...overrides,
});

/**
 * US-002: `RoleDto.expandedKeys` is the read-side of the role editor — the keys a role's entries
 * stand for, so the web can show what a role actually grants without re-implementing the grammar.
 * The behavior over HTTP is in `test/integration/permissions/permission-catalog.integration.spec.ts`.
 */
describe('RoleDto', () => {
  it('AC-5: answers expandedKeys [] and the stored entries unchanged when they no longer expand', () => {
    const stored = ['no.such.key'];

    const dto = RoleDto.from(role({ permissions: stored }));

    expect(dto.expandedKeys).toEqual([]);
    expect(dto.permissions).toEqual(['no.such.key']);
    // The input list is read, never rewritten: a stored entry the grammar refuses must survive the
    // projection so the editor can show (and fix) exactly what is in the row.
    expect(stored).toEqual(['no.such.key']);
  });

  it('answers the expanded keys of a valid entry list, ascending', () => {
    const dto = RoleDto.from(
      role({ permissions: ['ticket.read', 'comment.update.own', 'ticket.create'] }),
    );

    expect(dto.expandedKeys).toEqual(['comment.update.own', 'ticket.create', 'ticket.read']);
    expect(dto.permissions).toEqual(['ticket.read', 'comment.update.own', 'ticket.create']);
  });

  it('expands a wildcard in the role\'s own scope, so a PROJECT role never carries a global key', () => {
    const dto = RoleDto.from(role({ permissions: ['*'], scope: 'PROJECT' }));

    expect(dto.expandedKeys).toContain('ticket.delete');
    expect(dto.expandedKeys).not.toContain('user.create');
    expect(dto.expandedKeys).toEqual([...dto.expandedKeys].sort());
  });

  it('carries every other role field as stored', () => {
    const dto = RoleDto.from(
      role({ key: 'owner', name: 'Owner', description: 'All of it', scope: 'GLOBAL', system: true, locked: true }),
    );

    expect(dto).toEqual(
      expect.objectContaining({
        id: 'role-1',
        key: 'owner',
        name: 'Owner',
        description: 'All of it',
        scope: 'GLOBAL',
        system: true,
        locked: true,
      }),
    );
  });
});
