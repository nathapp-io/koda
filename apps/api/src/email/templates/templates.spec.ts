import { SimpleTemplateEngine } from '@nathapp/nestjs-notify';
import { EMAIL_TEMPLATE_CODES } from './template-codes';
import { EN_TEMPLATES } from './en';
import { ZH_TEMPLATES } from './zh';

const html = new SimpleTemplateEngine();
const plain = new SimpleTemplateEngine({ escapeHtml: false });

describe('email templates (S4b §3.4)', () => {
  it('defines every code in en', () => {
    expect(Object.keys(EN_TEMPLATES).sort()).toEqual([...EMAIL_TEMPLATE_CODES].sort());
  });

  it('renders a hostile title escaped in html and literal in the subject (Review Focus 3)', () => {
    const t = EN_TEMPLATES.NOTIFICATION;
    const data = { title: '<b>{{url}}</b>', body: '', url: 'https://k.x/a', prefsUrl: 'https://k.x/settings/notifications' };
    expect(plain.compile(t.subject)(data)).toBe('[koda] <b>{{url}}</b>');
    const out = html.compile(t.html)(data);
    expect(out).toContain('&lt;b&gt;{{url}}&lt;/b&gt;');
    expect(out).not.toContain('<b>');
    expect(out).toContain('https://k.x/settings/notifications');
  });

  it('zh entries, when present, use the same placeholders as en', () => {
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const [code, tpl] of Object.entries(ZH_TEMPLATES)) {
      const en = EN_TEMPLATES[code as keyof typeof EN_TEMPLATES];
      expect(vars(tpl.html)).toEqual(vars(en.html));
      expect(vars(tpl.subject)).toEqual(vars(en.subject));
    }
  });
});
