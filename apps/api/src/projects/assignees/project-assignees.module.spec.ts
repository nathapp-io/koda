import { Test, TestingModule } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectAssigneesRepository } from './prisma-project-assignees.repository';
import { ProjectAssigneesController } from './project-assignees.controller';
import { ProjectAssigneesModule } from './project-assignees.module';
import { ProjectAssigneesService } from './project-assignees.service';
import { PROJECT_ASSIGNEES_REPOSITORY } from './domain/project-assignee.domain';

// Stand-ins for the global PrismaModule so the REAL module under test compiles
// without a database. Mirrors src/projects/members/project-members.module.spec.ts.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: {} } },
    {
      provide: TRANSACTION_MANAGER,
      useValue: { run: <T>(fn: () => Promise<T>) => fn(), getClient: () => ({}), isInTransaction: () => false },
    },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER],
})
class FakeGlobalsModule {}

describe('ProjectAssigneesModule — DI wiring (no database)', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [FakeGlobalsModule, ProjectAssigneesModule],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('resolves the controller, service, repository and project access dependency', () => {
    expect(module.get(ProjectAssigneesController)).toBeInstanceOf(ProjectAssigneesController);
    expect(module.get(ProjectAssigneesService)).toBeInstanceOf(ProjectAssigneesService);
    expect(module.get(PrismaProjectAssigneesRepository)).toBeInstanceOf(PrismaProjectAssigneesRepository);
    expect(module.get(ProjectAccessService)).toBeInstanceOf(ProjectAccessService);
  });

  it('provides the repository behind its private token and keeps that token out of the exports', () => {
    expect(module.get(PROJECT_ASSIGNEES_REPOSITORY)).toBe(module.get(PrismaProjectAssigneesRepository));

    const exports = (Reflect.getMetadata('exports', ProjectAssigneesModule) ?? []) as unknown[];
    expect(exports).not.toContain(PROJECT_ASSIGNEES_REPOSITORY);
    expect(exports).not.toContain(PrismaProjectAssigneesRepository);
  });
});
