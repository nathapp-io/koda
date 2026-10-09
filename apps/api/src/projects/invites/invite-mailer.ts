import { Injectable, Logger } from '@nestjs/common';
import { EmailAvailability } from '../../email/email-availability';
import { EmailDispatcher } from '../../email/email-dispatcher';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';

/** Fleet S4b US-004: everything the inline invite email needs, token included. */
export interface InviteMailInput {
  inviteId: string;
  toEmail: string;
  locale: string;
  rawToken: string;
  projectName: string;
  inviterName: string;
  role: string;
  expiresAt: Date;
}

/**
 * Fleet S4b US-004: records one `INVITE` `EmailSchedule` row and sends it once through the dispatcher's
 * send step with retry disabled. The raw token lives only in this call (D526).
 */
@Injectable()
export class InviteMailer {
  private readonly logger = new Logger(InviteMailer.name);

  constructor(
    private readonly schedule: EmailScheduleService,
    private readonly dispatcher: EmailDispatcher,
    private readonly email: EmailAvailability,
  ) {}

  async sendInvite(input: InviteMailInput): Promise<boolean> {
    const now = new Date();
    const row = await this.schedule.startInviteSend({
      inviteId: input.inviteId,
      toEmail: input.toEmail,
      locale: input.locale,
      now,
    });

    const data = {
      projectName: input.projectName,
      inviterName: input.inviterName,
      role: input.role,
      url: this.email.webUrl(`/invite/${input.rawToken}`),
      expiresAt: input.expiresAt.toISOString(),
    };

    try {
      const outcome = await this.dispatcher.sendOne(row, 'INVITE', data, null, now, false);
      return outcome === 'SENT';
    } catch (error) {
      // The token hash is the only stored material, so a thrown send cannot be retried (D526).
      this.logger.warn(
        `invite email for invite ${input.inviteId} failed: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }
}
