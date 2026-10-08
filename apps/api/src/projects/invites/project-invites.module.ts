import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ProjectAccessModule } from '../project-access.module';
import { InviteMailer } from './invite-mailer';
import { PrismaProjectInvitesMembersRepository } from './prisma-project-invites-members.repository';
import { PrismaProjectInvitesRepository } from './prisma-project-invites.repository';
import { ProjectInvitesController } from './project-invites.controller';
import { ProjectInvitesService } from './project-invites.service';

/**
 * Fleet S4b US-004: project invites. `NotificationsModule` supplies `EmailDispatcher`; the invite and
 * membership writes live in this module's own repositories, so `ProjectMembersModule` is not imported.
 */
@Module({
  imports: [PrismaModule, ProjectAccessModule, NotificationsModule],
  controllers: [ProjectInvitesController],
  providers: [
    PrismaProjectInvitesRepository,
    PrismaProjectInvitesMembersRepository,
    InviteMailer,
    ProjectInvitesService,
  ],
})
export class ProjectInvitesModule {}
