import { InviteMailer } from './invite-mailer';
import type { EmailScheduleRow } from '../../email/schedule/email-schedule.types';

const NOW = new Date('2026-10-10T10:00:00Z');
const RAW = 'raw-token-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const EXPIRES = new Date('2026-10-17T10:00:00Z');

const inviteRow = (): EmailScheduleRow => ({
  id: 's1',
  kind: 'INVITE',
  notificationId: null,
  inviteId: 'i1',
  userId: null,
  projectId: null,
  toEmail: 'new@x.io',
  locale: 'en',
  attempts: 1,
  dueAt: NOW,
});

function setup(outcome: 'SENT' | 'FAILED' | 'RETRY' = 'SENT') {
  const row = inviteRow();
  const schedule = { startInviteSend: vi.fn(async () => row) };
  const dispatcher = { sendOne: vi.fn(async () => outcome) };
  const email = { configured: true, webUrl: (path: string) => `https://k.x${path}` };
  const mailer = new InviteMailer(schedule as never, dispatcher as never, email as never);
  const input = {
    inviteId: 'i1',
    toEmail: 'new@x.io',
    locale: 'en',
    rawToken: RAW,
    projectName: 'Koda',
    inviterName: 'Ada',
    role: 'DEVELOPER',
    expiresAt: EXPIRES,
  };
  return { mailer, schedule, dispatcher, email, input };
}

describe('InviteMailer (S4b US-004)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-10: records the INVITE send and sends the raw link once with retry disabled', async () => {
    const { mailer, schedule, dispatcher, input } = setup('SENT');

    await expect(mailer.sendInvite(input)).resolves.toBe(true);

    expect(schedule.startInviteSend).toHaveBeenCalledWith({
      inviteId: 'i1', toEmail: 'new@x.io', locale: 'en', now: NOW,
    });
    expect(dispatcher.sendOne).toHaveBeenCalledWith(
      inviteRow(),
      'INVITE',
      {
        projectName: 'Koda',
        inviterName: 'Ada',
        role: 'DEVELOPER',
        url: `https://k.x/invite/${RAW}`,
        expiresAt: EXPIRES.toISOString(),
      },
      null,
      NOW,
      false,
    );
  });

  it('AC-11: a FAILED send is reported as emailed false', async () => {
    const { mailer, input } = setup('FAILED');

    await expect(mailer.sendInvite(input)).resolves.toBe(false);
  });

  it('AC-11: a non-SENT outcome (RETRY) is reported as emailed false', async () => {
    const { mailer, input } = setup('RETRY');

    await expect(mailer.sendInvite(input)).resolves.toBe(false);
  });

  it('AC-11: a thrown send is caught and reported as emailed false', async () => {
    const { mailer, dispatcher, input } = setup('SENT');
    dispatcher.sendOne.mockRejectedValueOnce(new Error('SMTP down'));

    await expect(mailer.sendInvite(input)).resolves.toBe(false);
  });
});
