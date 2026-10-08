import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AuthModule } from '../../auth/auth.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ProjectAccessModule } from '../project-access.module';
import { InviteAcceptanceService } from './invite-acceptance.service';
import { InviteMailer } from './invite-mailer';
import { PrismaProjectInvitesMembersRepository } from './prisma-project-invites-members.repository';
import { PrismaProjectInvitesRepository } from './prisma-project-invites.repository';
import { ProjectInvitesController } from './project-invites.controller';
import { ProjectInvitesService } from './project-invites.service';
import { PublicInvitesController } from './public-invites.controller';

/**
 * Fleet S4b US-004/US-005: project invites. `NotificationsModule` supplies `EmailDispatcher`; the invite and
 * membership writes live in this module's own repositories, so `ProjectMembersModule` is not imported.
 * `AuthModule` supplies `AuthService` — the accept flow issues the new member's session through it.
 */
@Module({
  imports: [PrismaModule, ProjectAccessModule, NotificationsModule, AuthModule],
  controllers: [ProjectInvitesController, PublicInvitesController],
  providers: [
    PrismaProjectInvitesRepository,
    PrismaProjectInvitesMembersRepository,
    InviteMailer,
    ProjectInvitesService,
    InviteAcceptanceService,
  ],
})
export class ProjectInvitesModule {}
