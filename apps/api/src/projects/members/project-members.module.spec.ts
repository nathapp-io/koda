import { MemberRouteCommands } from './member-route.commands';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';
import { ProjectMembersController } from './project-members.controller';
import { ProjectRolesController } from './project-roles.controller';
import { ProjectMembersModule } from './project-members.module';
import { ProjectMembersService } from './project-members.service';

describe('ProjectMembersModule — DI wiring (no database)', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [GlobalStubsModule, ProjectMembersModule],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('AC-10: registers the route command after init', async () => {
    await module.init();
    expect(module.get(MemberRouteCommands)).toBeInstanceOf(MemberRouteCommands);
    expect(module.get(ApprovalCommandRegistry).get('member.add', 'rest:project-members.add')).toBeDefined();
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
