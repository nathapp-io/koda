/** Fleet S4b §3.4: template codes, also the nestjs-notify templateCode values. */
export const EMAIL_TEMPLATE_CODES = ['NOTIFICATION', 'INVITE', 'MEMBER_ADDED'] as const;
export type EmailTemplateCode = (typeof EMAIL_TEMPLATE_CODES)[number];

export interface EmailTemplateText {
  subject: string;
  html: string;
}

export const EMAIL_LOCALES = ['en', 'zh'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];
