import { TicketResponseDto } from './ticket-response.dto';

describe('TicketResponseDto', () => {
  it('maps PR tracking fields onto links in ticket detail responses', () => {
    const dto = TicketResponseDto.from({
      id: 'ticket-1',
      projectId: 'project-1',
      number: 42,
      type: 'TASK',
      title: 'Test ticket',
      description: null,
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      assignedToUserId: null,
      assignedToAgentId: null,
      createdByUserId: null,
      createdByAgentId: null,
      gitRefVersion: null,
      gitRefFile: null,
      gitRefLine: null,
      gitRefUrl: null,
      createdAt: new Date('2026-04-07T00:00:00Z'),
      updatedAt: new Date('2026-04-07T00:00:00Z'),
      deletedAt: null,
      labels: [],
      links: [
        {
          id: 'link-1',
          ticketId: 'ticket-1',
          url: 'https://github.com/owner/repo/pull/42',
          provider: 'github',
          externalRef: 'owner/repo#42',
          prState: 'merged',
          prNumber: 42,
          prUpdatedAt: new Date('2026-04-07T01:00:00Z'),
          createdAt: new Date('2026-04-07T00:30:00Z'),
        },
      ],
    }, 'KODA');

    expect(dto.links).toEqual([
      expect.objectContaining({
        externalRef: 'owner/repo#42',
        prState: 'merged',
        prNumber: 42,
        prUpdatedAt: new Date('2026-04-07T01:00:00Z'),
      }),
    ]);
  });
});
