import { Inject, Injectable } from '@nestjs/common';
import { EmailProvider, SmtpEmailProvider } from '@nathapp/nestjs-notification';
import {
  DeliverySendResult, IDeliveryChannel, NotificationChannel, PermanentNotificationError, SendNotificationPayload,
} from '@nathapp/nestjs-notify';
import { EmailAvailability } from './email-availability';

export const SMTP_EMAIL_PROVIDER = Symbol('SMTP_EMAIL_PROVIDER');

/** S4b R1: the SMTP provider is built directly; null when SMTP_URL is unset (R2). */
export function smtpEmailProviderFactory(availability: EmailAvailability): EmailProvider | null {
  const cfg = availability.config();
  if (!cfg.smtpUrl || !cfg.from) return null;
  try {
    return new SmtpEmailProvider({ url: cfg.smtpUrl, from: cfg.from });
  } catch {
    // nodemailer's URL errors carry the full input (credentials); never let it reach the boot log.
    throw new Error('SMTP_URL could not be used to create the SMTP transport');
  }
}

/** A 5xx SMTP reply about the recipient will not succeed on retry. */
const PERMANENT_SMTP = /\b55[0-4]\b/;

/**
 * Fleet S4b §1: nestjs-notify delivery channel for 'email'. Receives the already-rendered subject and html.
 * A failed send throws so the package logs it FAILED and the caller decides on retry.
 */
@Injectable()
export class SmtpDeliveryChannel implements IDeliveryChannel {
  readonly channel = NotificationChannel.EMAIL;

  constructor(@Inject(SMTP_EMAIL_PROVIDER) private readonly provider: EmailProvider | null) {}

  async send(payload: SendNotificationPayload, content: string, subject?: string): Promise<DeliverySendResult> {
    if (!this.provider) throw new PermanentNotificationError('email is not configured');
    const result = await this.provider.send({ recipient: payload.recipient, subject: subject ?? '', message: content });
    if (result.success) return { providerMessageId: result.requestId };
    const message = result.message ?? 'email send failed';
    if (PERMANENT_SMTP.test(message)) throw new PermanentNotificationError(message);
    throw new Error(message);
  }
}
