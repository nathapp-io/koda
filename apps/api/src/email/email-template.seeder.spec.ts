import { EmailTemplateSeeder } from './email-template.seeder';
import { EMAIL_TEMPLATE_CODES } from './templates/template-codes';

type Seeded = { code: string; locale: string; subject: string; content: string };

function setup(existing: Record<string, { id: string; subject: string; content: string }> = {}) {
  const repo = { findTemplate: jest.fn(async (code: string, locale: string) => existing[`${code}:${locale}`] ?? null) };
  const service = { create: jest.fn(async (x: unknown) => x), update: jest.fn(async (x: unknown) => x) };
  return { seeder: new EmailTemplateSeeder(repo as never, service as never), repo, service };
}

describe('EmailTemplateSeeder (S4b §1, R3)', () => {
  it('creates en and zh for every code with tenant default and channel email', async () => {
    const { seeder, service } = setup();
    await expect(seeder.seed()).resolves.toBe(EMAIL_TEMPLATE_CODES.length * 2);
    expect(service.create).toHaveBeenCalledTimes(EMAIL_TEMPLATE_CODES.length * 2);
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'default', channel: 'email', locale: 'zh', code: 'INVITE' }));
  });

  it('updates only templates whose text changed (idempotent)', async () => {
    const first = setup();
    await first.seeder.seed();
    const created = first.service.create.mock.calls.map(([c]) => c as Seeded);
    const existing = Object.fromEntries(created.map((c, i) => [`${c.code}:${c.locale}`, { id: `t${i}`, subject: c.subject, content: c.content }]));
    existing['INVITE:en'] = { ...existing['INVITE:en'], content: 'old' };
    const second = setup(existing);
    await expect(second.seeder.seed()).resolves.toBe(1);
    expect(second.service.create).not.toHaveBeenCalled();
    expect(second.service.update).toHaveBeenCalledTimes(1);
    expect(second.service.update).toHaveBeenCalledWith(existing['INVITE:en'].id, 'default', expect.objectContaining({ content: expect.stringContaining('{{url}}') }));
  });

  it('falls back to en text for a code missing from zh', async () => {
    const { seeder, service } = setup();
    await seeder.seed();
    const calls = service.create.mock.calls.map(([c]) => c as Seeded);
    const zh = calls.find((c) => c.code === 'MEMBER_ADDED' && c.locale === 'zh');
    const en = calls.find((c) => c.code === 'MEMBER_ADDED' && c.locale === 'en');
    expect(zh?.content).toBe(en?.content);
  });
});
