import { effectiveStatus, ProjectInviteRecord } from './project-invite.domain';

const NOW = new Date('2026-10-10T10:00:00Z');
const plusDays = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);

const record = (over: Partial<ProjectInviteRecord> = {}): ProjectInviteRecord => ({
  id: 'i1',
  projectId: 'p1',
  email: 'new@x.io',
  role: 'DEVELOPER',
  status: 'PENDING',
  invitedById: 'admin',
  inviterName: 'Ada',
  acceptedByUserId: null,
  acceptedAt: null,
  expiresAt: plusDays(NOW, 7),
  createdAt: NOW,
  ...over,
});

describe('effectiveStatus (S4b US-004)', () => {
  it('AC-9: an overdue PENDING invite reads as EXPIRED', () => {
    expect(effectiveStatus(record({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe('EXPIRED');
  });

  it('AC-9: a PENDING invite that has not expired yet stays PENDING', () => {
    expect(effectiveStatus(record({ expiresAt: plusDays(NOW, 1) }), NOW)).toBe('PENDING');
  });

  it('AC-9: ACCEPTED and CANCELLED are never rewritten, even when overdue', () => {
    const overdue = new Date(NOW.getTime() - 1);

    expect(effectiveStatus(record({ status: 'ACCEPTED', expiresAt: overdue }), NOW)).toBe('ACCEPTED');
    expect(effectiveStatus(record({ status: 'CANCELLED', expiresAt: overdue }), NOW)).toBe('CANCELLED');
  });
});
