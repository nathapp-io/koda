import { canRunDbTests } from '../../helpers/test-environment';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { SystemRoleSeeder } from '../../../src/permissions/system-role.seeder';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('system role seeder audit (real AppModule)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let seeder: SystemRoleSeeder;
  const rows = () => db.auditEntry.findMany({ where: { key: 'role.manage', actorId: 'seed' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    seeder = app.get(SystemRoleSeeder);
  });
  beforeEach(async () => {
    await db.auditEntry.deleteMany();
    const viewer = await db.role.findUniqueOrThrow({ where: { key: 'viewer' } });
    await db.role.update({ where: { id: viewer.id }, data: { name: 'Viewer' } });
    const owner = await db.role.findUniqueOrThrow({ where: { key: 'owner' } });
    await db.role.update({ where: { id: owner.id }, data: { name: 'Owner', scope: 'GLOBAL', permissions: ['*'] } });
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: attributes restoring viewer to SYSTEM/seed with fields summary', async () => {
    const viewer = await db.role.findUniqueOrThrow({ where: { key: 'viewer' } });
    await db.role.update({ where: { id: viewer.id }, data: { name: 'Renamed viewer' } });
    await seeder.onApplicationBootstrap();
    expect(await rows()).toEqual([expect.objectContaining({ key: 'role.manage', resourceType: 'role', resourceId: viewer.id, projectId: null, actorType: 'SYSTEM', actorId: 'seed', origin: 'system', summary: 'restored from seed, fields: name, scope' })]);
  });

  it('AC-2: records writes, then records nothing on an unchanged second bootstrap', async () => {
    const viewer = await db.role.findUniqueOrThrow({ where: { key: 'viewer' } });
    await db.role.update({ where: { id: viewer.id }, data: { name: 'Changed viewer for AC-2' } });

    await seeder.onApplicationBootstrap();
    const before = await db.auditEntry.count({ where: { key: 'role.manage', actorId: 'seed' } });
    expect(before).toBeGreaterThan(0);
    expect(await rows()).toEqual([expect.objectContaining({
      key: 'role.manage', resourceId: viewer.id, actorId: 'seed',
      summary: 'restored from seed, fields: name, scope',
    })]);

    await seeder.onApplicationBootstrap();
    expect(await db.auditEntry.count({ where: { key: 'role.manage', actorId: 'seed' } })).toBe(before);
  });

  it('AC-3: audit rejection rolls back the restored role write', async () => {
    const viewer = await db.role.findUniqueOrThrow({ where: { key: 'viewer' } });
    await db.role.update({ where: { id: viewer.id }, data: { name: 'Renamed again' } });
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'role.manage') throw new Error('audit down');
      return original(input);
    });
    try { await expect(seeder.onApplicationBootstrap()).rejects.toThrow('audit down'); }
    finally { spy.mockRestore(); }
    expect((await db.role.findUniqueOrThrow({ where: { id: viewer.id } })).name).toBe('Renamed again');
  });

  it('AC-5: restores owner with permissions and records all fields', async () => {
    const owner = await db.role.findUniqueOrThrow({ where: { key: 'owner' } });
    await db.role.update({ where: { id: owner.id }, data: { name: 'Renamed owner' } });
    await seeder.onApplicationBootstrap();
    expect(await rows()).toEqual([expect.objectContaining({ resourceId: owner.id, actorId: 'seed', summary: 'restored from seed, fields: name, permissions, scope' })]);
  });
});
