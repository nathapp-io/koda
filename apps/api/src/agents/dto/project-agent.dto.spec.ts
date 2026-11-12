import { ProjectAgentDto } from './project-agent.dto';

describe('ProjectAgentDto', () => {
  it('US-001 AC-1: copies the agent row id into the roster DTO', () => {
    const dto = ProjectAgentDto.from({
      id: 'agent-1', slug: 'bot', name: 'Probe Bot', status: 'ACTIVE', capabilities: [],
      openTicketCount: 0, openTicketRefs: [], addedAt: new Date('2026-01-01T00:00:00Z'),
      addedById: null, addedByName: null,
    });
    expect(dto.id).toBe('agent-1');
  });
});
