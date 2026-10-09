import { EmailScheduleRepository } from './email-schedule.repository';

interface CreateArgs {
  data: Record<string, unknown>;
}

/** Hermetic fake of the two Prisma delegates the invite paths touch. */
function setup() {
  const emailSchedule = {
    create: jest.fn(async ({ data }: CreateArgs) => ({
      id: 'row-1',
      kind: data['kind'] as string,
      notificationId: null,
      inviteId: (data['inviteId'] as string | null) ?? null,
      userId: null,
      projectId: null,
      toEmail: data['toEmail'] as string,
      locale: data['locale'] as string,
      attempts: data['attempts'] as number,
      dueAt: data['dueAt'] as Date,
    })),
    updateMany: jest.fn(async () => ({ count: 1 })),
  };
  const repo = new EmailScheduleRepository({ client: { emailSchedule } } as never);
  return { repo, emailSchedule };
}

describe('EmailScheduleRepository (S4b US-001 invite recovery)', () => {
  const now = new Date('2026-10-10T10:00:00Z');

  it('US-001: startInviteSend records the row SENDING, attempts 1 and a fresh 2-minute lock', async () => {
    const { repo, emailSchedule } = setup();
    const row = await repo.startInviteSend({ inviteId: 'inv-1', toEmail: 'a@x.io', locale: 'zh', now });

    expect(emailSchedule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'INVITE',
        inviteId: 'inv-1',
        toEmail: 'a@x.io',
        locale: 'zh',
        status: 'SENDING',
        attempts: 1,
      }),
    });
    const data = emailSchedule.create.mock.calls[0][0].data as { lockedUntil: Date };
    expect(data.lockedUntil.getTime()).toBe(now.getTime() + 2 * 60_000);
    expect(row).toEqual(expect.objectContaining({ id: 'row-1', kind: 'INVITE', attempts: 1 }));
  });

  it('US-001: closeAbandonedInvites fails an invite whose lock expired and records why', async () => {
    const { repo, emailSchedule } = setup();
    const count = await repo.closeAbandonedInvites(now);

    expect(count).toBe(1);
    expect(emailSchedule.updateMany).toHaveBeenCalledWith({
      where: { kind: 'INVITE', status: 'SENDING', lockedUntil: { lt: now } },
      data: { status: 'FAILED', lastError: 'abandoned', lockedUntil: null },
    });
  });
});
