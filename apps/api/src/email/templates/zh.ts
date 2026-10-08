import type { EmailTemplateCode, EmailTemplateText } from './template-codes';

const footer = '<p style="color:#666;font-size:12px">此邮件依据你的 koda 通知设置发送。<a href="{{prefsUrl}}">管理邮件偏好</a></p>';

/** Fleet S4b §3.4: zh is partial by design; missing codes are seeded from en. */
export const ZH_TEMPLATES: Partial<Record<EmailTemplateCode, EmailTemplateText>> = {
  NOTIFICATION: {
    subject: '[koda] {{title}}',
    html: '<p><strong>{{title}}</strong></p><p>{{body}}</p><p><a href="{{url}}">在 koda 中打开</a></p>' + footer,
  },
  INVITE: {
    subject: '[koda] {{inviterName}} 邀请你加入 {{projectName}}',
    html: '<p>{{inviterName}} 邀请你以 {{role}} 身份加入 koda 项目 <strong>{{projectName}}</strong>。</p>'
      + '<p><a href="{{url}}">接受邀请</a></p><p>此链接仅可使用一次，于 {{expiresAt}} 过期。</p>',
  },
};
