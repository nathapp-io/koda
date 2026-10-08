import type { EmailTemplateCode, EmailTemplateText } from './template-codes';

const footer = '<p style="color:#666;font-size:12px">You received this because of your koda notification settings. '
  + '<a href="{{prefsUrl}}">Manage email preferences</a></p>';

/** Fleet S4b §3.4. Placeholders are {{name}}; values are HTML-escaped in html, raw in the subject. */
export const EN_TEMPLATES: Record<EmailTemplateCode, EmailTemplateText> = {
  NOTIFICATION: {
    subject: '[koda] {{title}}',
    html: '<p><strong>{{title}}</strong></p><p>{{body}}</p><p><a href="{{url}}">Open in koda</a></p>' + footer,
  },
  INVITE: {
    subject: '[koda] {{inviterName}} invited you to {{projectName}}',
    html: '<p>{{inviterName}} invited you to join <strong>{{projectName}}</strong> on koda as {{role}}.</p>'
      + '<p><a href="{{url}}">Accept the invite</a></p><p>This link works once and expires on {{expiresAt}}.</p>',
  },
  MEMBER_ADDED: {
    subject: '[koda] You were added to {{projectName}}',
    html: '<p>You were added to <strong>{{projectName}}</strong> on koda as {{role}}.</p>'
      + '<p><a href="{{url}}">Open the project</a></p>',
  },
};
