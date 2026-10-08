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
 * Fleet S4b US-004 test-writer stub (RED state).
 *
 * Records one `INVITE` `EmailSchedule` row and sends it once through the dispatcher's
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

  async sendInvite(_input: InviteMailInput): Promise<boolean> {
    return true;
  }
}
