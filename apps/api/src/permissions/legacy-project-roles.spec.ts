import {
  ROLE_KEY_FOR_LEGACY_ROLE,
  legacyRoleForRoleKey,
  strongestProjectRole,
} from './legacy-project-roles';

/**
 * US-001 AC-1/AC-2 — the legacy role mapping: role key to legacy role, and the strongest of several
 * legacy roles. Pure functions, no database.
 */
describe('legacy-project-roles', () => {
  describe('legacyRoleForRoleKey (AC-1)', () => {
    it('AC-1: maps project-admin to ADMIN and developer to DEVELOPER', () => {
      expect(legacyRoleForRoleKey('project-admin')).toBe('ADMIN');
      expect(legacyRoleForRoleKey('developer')).toBe('DEVELOPER');
    });

    it('AC-1: maps viewer, reviewer and qa-lead to VIEWER', () => {
      expect(legacyRoleForRoleKey('viewer')).toBe('VIEWER');
      expect(legacyRoleForRoleKey('reviewer')).toBe('VIEWER');
      expect(legacyRoleForRoleKey('qa-lead')).toBe('VIEWER');
    });

    it('maps every other key, and an unknown key, to the least-privileged legacy set', () => {
      expect(legacyRoleForRoleKey('verifier')).toBe('VIEWER');
      expect(legacyRoleForRoleKey('owner')).toBe('VIEWER');
      expect(legacyRoleForRoleKey('')).toBe('VIEWER');
    });

    it('is the inverse of ROLE_KEY_FOR_LEGACY_ROLE', () => {
      expect(ROLE_KEY_FOR_LEGACY_ROLE).toEqual({
        ADMIN: 'project-admin',
        DEVELOPER: 'developer',
        VIEWER: 'viewer',
      });
      expect(legacyRoleForRoleKey(ROLE_KEY_FOR_LEGACY_ROLE.ADMIN)).toBe('ADMIN');
      expect(legacyRoleForRoleKey(ROLE_KEY_FOR_LEGACY_ROLE.DEVELOPER)).toBe('DEVELOPER');
      expect(legacyRoleForRoleKey(ROLE_KEY_FOR_LEGACY_ROLE.VIEWER)).toBe('VIEWER');
    });
  });

  describe('strongestProjectRole (AC-2)', () => {
    it('AC-2: ranks ADMIN above DEVELOPER above VIEWER', () => {
      expect(strongestProjectRole(['VIEWER', 'ADMIN', 'DEVELOPER'])).toBe('ADMIN');
    });

    it('AC-2: ranks a legacy role above a string it does not know', () => {
      expect(strongestProjectRole(['AGENT', 'VIEWER'])).toBe('VIEWER');
    });

    it('AC-2: an empty list answers null', () => {
      expect(strongestProjectRole([])).toBeNull();
    });

    it('keeps a legacy value it does not know when it is the only one', () => {
      expect(strongestProjectRole(['MEMBER'])).toBe('MEMBER');
    });

    it('answers the lexicographically smallest of two unknown roles', () => {
      expect(strongestProjectRole(['zeta', 'alpha'])).toBe('alpha');
      expect(strongestProjectRole(['beta', 'alpha', 'gamma'])).toBe('alpha');
    });

    it('does not mutate the list it is given', () => {
      const roles = ['VIEWER', 'ADMIN'];
      strongestProjectRole(roles);
      expect(roles).toEqual(['VIEWER', 'ADMIN']);
    });
  });
});
