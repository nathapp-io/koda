import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_CFG, IEmailConfig } from '../config/email.config';

/** Fleet S4b D520: the single switch every email path checks. */
@Injectable()
export class EmailAvailability {
  constructor(private readonly configService: ConfigService) {}

  config(): IEmailConfig {
    return this.configService.get<IEmailConfig>(EMAIL_CFG) as IEmailConfig;
  }

  get configured(): boolean {
    return this.config().smtpUrl !== null;
  }

  /** Absolute link for an email, from WEB_PUBLIC_URL only (never request headers). */
  webUrl(path: string): string {
    const base = this.config().webPublicUrl;
    if (!base) throw new Error('WEB_PUBLIC_URL is not configured');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
