import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { EmailAvailability } from '../../email/email-availability';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { PrismaProjectMembersRepository } from '../members/prisma-project-members.repository';
import { ProjectAccessService } from '../project-access.service';
import { InviteMailer } from './invite-mailer';
import { PrismaProjectInvitesRepository } from './prisma-project-invites.repository';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InviteCreateResultDto, InviteDto } from './dto/invite.dto';

/**
 * Fleet S4b US-004 test-writer stub (RED state).
 *
 * The implementer owns the create/list behaviour: normalise the email, add an existing
 * active user or invite a new address, and list invites with the effective status.
 */
@Injectable()
export class ProjectInvitesService {
  constructor(
    private readonly invites: PrismaProjectInvitesRepository,
    private readonly members: PrismaProjectMembersRepository,
    private readonly access: ProjectAccessService,
    private readonly mailer: InviteMailer,
    private readonly schedule: EmailScheduleService,
    private readonly email: EmailAvailability,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async create(
    _slug: string,
    _dto: CreateInviteDto,
    _principal: KodaPrincipal,
    _locale: string,
  ): Promise<InviteCreateResultDto> {
    return { outcome: 'ADDED' };
  }

  async list(_slug: string, _principal: KodaPrincipal): Promise<InviteDto[]> {
    return [];
  }
}
