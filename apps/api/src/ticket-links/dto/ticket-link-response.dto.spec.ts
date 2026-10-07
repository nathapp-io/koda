import { TicketLinkResponseDto } from './ticket-link-response.dto';

const base = { id: 'l1', ticketId: 't1', url: 'u', provider: 'github', externalRef: 'acme/app#9', prState: 'open', prNumber: 9, prUpdatedAt: null, linkType: 'pr', createdAt: new Date(0) };

describe('TicketLinkResponseDto.from (C9 §2, slice 1b)', () => {
  it('passes source and jobId through', () => {
    expect(TicketLinkResponseDto.from({ ...base, source: 'fleet', jobId: 'j1' })).toEqual(expect.objectContaining({ source: 'fleet', jobId: 'j1' }));
  });

  it('defaults a row without them to vcs / null', () => {
    expect(TicketLinkResponseDto.from(base)).toEqual(expect.objectContaining({ source: 'vcs', jobId: null }));
  });
});
