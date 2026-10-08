import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { InviteMailer } from './invite-mailer';
import { PrismaProjectInvitesMembersRepository } from './prisma-project-invites-members.repository';
import { PrismaProjectInvitesRepository } from './prisma-project-invites.repository';
import { ProjectInvitesController } from './project-invites.controller';
import { ProjectInvitesModule } from './project-invites.module';
import { ProjectInvitesService } from './project-invites.service';

/** S4b US-004: module-registration wiring only — no database (see api-testing rules). */
describe('ProjectInvitesModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, ProjectInvitesModule],
    }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('exposes the controller behind the service', () => {
    expect(moduleRef.get(ProjectInvitesController)).toBeInstanceOf(ProjectInvitesController);
    expect(moduleRef.get(ProjectInvitesService)).toBeInstanceOf(ProjectInvitesService);
    expect(moduleRef.get(InviteMailer)).toBeInstanceOf(InviteMailer);
  });

  it('resolves the module-private repositories', () => {
    expect(moduleRef.get(PrismaProjectInvitesRepository)).toBeInstanceOf(PrismaProjectInvitesRepository);
    expect(moduleRef.get(PrismaProjectInvitesMembersRepository)).toBeInstanceOf(
      PrismaProjectInvitesMembersRepository,
    );
  });
});
