import { EN_TEMPLATES } from './en';
import { ZH_TEMPLATES } from './zh';
import { EmailTemplateSeeder } from '../email-template.seeder';

describe('password reset templates', () => {
  it('AC-10: includes the English subject and placeholders', () => {
    const t = EN_TEMPLATES['PASSWORD_RESET' as keyof typeof EN_TEMPLATES];
    expect(t?.subject).toBe('[koda] Reset your password');
    expect(t?.html).toContain('{{url}}');
    expect(t?.html).toContain('{{expiresAt}}');
  });
  it('AC-11: includes Chinese subject and placeholders', () => {
    const t = ZH_TEMPLATES['PASSWORD_RESET' as keyof typeof ZH_TEMPLATES];
    expect(t?.subject).toBeTruthy();
    expect(t?.html).toContain('{{url}}');
    expect(t?.html).toContain('{{expiresAt}}');
  });
  it('AC-12: seeds reset templates in both locales', async () => {
    const create = vi.fn(async (x: unknown) => x);
    const seeder = new EmailTemplateSeeder({ findTemplate: vi.fn().mockResolvedValue(null) } as never, { create } as never);
    await seeder.seed();
    for (const locale of ['en', 'zh']) expect(create).toHaveBeenCalledWith(expect.objectContaining({ code: 'PASSWORD_RESET', locale }));
  });
});
