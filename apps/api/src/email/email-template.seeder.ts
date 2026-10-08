import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
  ITemplateRepository, ITemplateService, NotificationChannel, TEMPLATE_REPOSITORY, TEMPLATE_SERVICE,
} from '@nathapp/nestjs-notify';
import { KODA_TENANT_ID } from './koda-tenant';
import { EMAIL_LOCALES, EMAIL_TEMPLATE_CODES, EmailLocale, EmailTemplateCode, EmailTemplateText } from './templates/template-codes';
import { EN_TEMPLATES } from './templates/en';
import { ZH_TEMPLATES } from './templates/zh';

const BY_LOCALE: Record<EmailLocale, Partial<Record<EmailTemplateCode, EmailTemplateText>>> = { en: EN_TEMPLATES, zh: ZH_TEMPLATES };

/** Fleet S4b R3: templates live in git; each boot upserts them into nestjs-notify's table for KODA_TENANT_ID. */
@Injectable()
export class EmailTemplateSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmailTemplateSeeder.name);

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly repo: ITemplateRepository,
    @Inject(TEMPLATE_SERVICE) private readonly templates: ITemplateService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const changed = await this.seed();
    if (changed > 0) this.logger.log(`Seeded ${changed} email template(s)`);
  }

  /** Returns how many rows were created or updated. */
  async seed(): Promise<number> {
    let changed = 0;
    for (const locale of EMAIL_LOCALES) {
      for (const code of EMAIL_TEMPLATE_CODES) {
        const text = BY_LOCALE[locale][code] ?? EN_TEMPLATES[code];
        const current = await this.repo.findTemplate(code, locale, KODA_TENANT_ID, NotificationChannel.EMAIL);
        if (!current) {
          await this.templates.create({
            tenantId: KODA_TENANT_ID, code, locale, channel: NotificationChannel.EMAIL, subject: text.subject, content: text.html,
          });
          changed += 1;
        } else if (current.subject !== text.subject || current.content !== text.html) {
          await this.templates.update(current.id, KODA_TENANT_ID, { subject: text.subject, content: text.html });
          changed += 1;
        }
      }
    }
    return changed;
  }
}
