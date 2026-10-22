import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PERMISSION_CATALOG } from './catalog';
import { PermissionCatalogEntryDto } from './dto/permission-catalog-entry.dto';
import { PermissionCatalogController } from './permission-catalog.controller';
import { REQUIRES_METADATA } from './requires.decorator';
import { RequiresGuard } from './requires.guard';

/**
 * US-002: the catalog route's declaration, its projection and its ordering. The route over HTTP is in
 * `test/integration/permissions/permission-catalog.integration.spec.ts`; this spec pins the branches
 * that a booted app only exercises once.
 */
describe('PermissionCatalogController', () => {
  const controller = new PermissionCatalogController();

  /** The envelope's payload, typed as the route answers it. */
  const entries = (): PermissionCatalogEntryDto[] =>
    controller.list().data as PermissionCatalogEntryDto[];

  it('declares role.read on the handler and runs RequiresGuard', () => {
    const handler = (PermissionCatalogController.prototype as unknown as Record<string, object>)['list'];

    expect(Reflect.getMetadata(REQUIRES_METADATA, handler)).toEqual({
      keys: ['role.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
    const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
    expect(guards).toContain(RequiresGuard);
  });

  it('answers one entry per role-grantable catalog key, sorted by key', () => {
    const keys = entries().map((entry) => entry.key);

    expect(keys).toEqual(
      PERMISSION_CATALOG.filter((entry) => entry.access === 'role')
        .map((entry) => entry.key)
        .sort(),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never answers a key no role can hold', () => {
    const notGrantable = new Set(
      PERMISSION_CATALOG.filter((entry) => entry.access !== 'role').map((entry) => entry.key),
    );

    expect(entries().filter((entry) => notGrantable.has(entry.key))).toEqual([]);
    // A concrete sample, so a wholesale `access` change in the catalog cannot make this vacuous.
    expect(entries().map((entry) => entry.key)).not.toContain('auth.me.read');
    expect(entries().map((entry) => entry.key)).not.toContain('session.login');
    expect(entries().map((entry) => entry.key)).not.toContain('runner.sync');
    expect(entries().map((entry) => entry.key)).not.toContain('system.outbox.retention');
  });

  it('projects exactly the five metadata fields of an entry', () => {
    const entry = entries().find((candidate) => candidate.key === 'comment.update');

    expect(entry).toEqual({
      key: 'comment.update',
      scope: 'any',
      risk: 'medium',
      principals: ['user', 'agent'],
      ownable: true,
    });
    // `access` and `approval` stay in code: the route lists role keys only, so both would be noise.
    expect(Object.keys(entry as object).sort()).toEqual(['key', 'ownable', 'principals', 'risk', 'scope']);
  });

  it('copies the principals list, so a caller cannot mutate the catalog', () => {
    const entry = entries().find((candidate) => candidate.key === 'ticket.read') as PermissionCatalogEntryDto;
    const catalogEntry = PERMISSION_CATALOG.find((candidate) => candidate.key === 'ticket.read');

    entry.principals.push('agent');

    expect(catalogEntry?.principals).toEqual(['user', 'agent']);
  });
});
