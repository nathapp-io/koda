import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { MembershipService } from '../../permissions/membership.service';
import { PermissionService } from '../../permissions/permission.service';
import { RoleAdminService } from '../../permissions/role-admin.service';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';
import { ProjectMembersController } from './project-members.controller';
import { ProjectRolesController } from './project-roles.controller';
import { ProjectMembersModule } from './project-members.module';
import { ProjectMembersService } from './project-members.service';

// Stand-ins for the global PrismaModule so the REAL module under test compiles
// without a database. Mirrors src/outbox/outbox.module.spec.ts.
@Global()
@Module({
  providers: [
    { provide: MembershipService, useValue: {} },
    // US-008: RequiresGuard is instantiated by the DI container (the controller carries it
    // class-level) and needs the global PermissionService.
    { provide: PermissionService, useValue: { can: vi.fn() } },
    // US-003: ProjectRolesController reads the PROJECT-scope roles through the global RoleAdminService.
    { provide: RoleAdminService, useValue: { listProjectRoles: vi.fn() } },
    { provide: PrismaService, useValue: { client: {} } },
    {
      provide: TRANSACTION_MANAGER,
      useValue: { run: <T>(fn: () => Promise<T>) => fn(), getClient: () => ({}), isInTransaction: () => false },
    },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, MembershipService, PermissionService, RoleAdminService],
})
class FakeGlobalsModule {}

describe('ProjectMembersModule — DI wiring (no database)', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [FakeGlobalsModule, ProjectMembersModule],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('resolves the controller, service, repository and project access dependency', () => {
    expect(module.get(ProjectMembersController)).toBeInstanceOf(ProjectMembersController);
    expect(module.get(ProjectMembersService)).toBeInstanceOf(ProjectMembersService);
    expect(module.get(PrismaProjectMembersRepository)).toBeInstanceOf(PrismaProjectMembersRepository);
    expect(module.get(ProjectAccessService)).toBeInstanceOf(ProjectAccessService);
  });

  it('US-003: resolves the project roles controller', () => {
    expect(module.get(ProjectRolesController)).toBeInstanceOf(ProjectRolesController);
  });
});
