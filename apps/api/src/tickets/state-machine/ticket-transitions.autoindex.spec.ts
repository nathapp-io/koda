import { TicketTransitionsService } from './ticket-transitions.service';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function build(ticketRow: Record<string, unknown> | null) {
  const repo = { findTicketWithComments: jest.fn().mockResolvedValue(ticketRow) };
  const ragService = { indexDocument: jest.fn().mockResolvedValue('doc-1') };
  const service = new TicketTransitionsService(repo as never, { run: jest.fn() } as never, ragService as never);
  const autoIndex = (service as unknown as {
    autoIndexTicket: (project: { id: string; key: string; autoIndexOnClose: boolean }, ticket: { id: string }) => void;
  }).autoIndexTicket.bind(service);
  return { autoIndex, ragService };
}

const project = { id: 'proj-1', key: 'KODA', autoIndexOnClose: true };
const baseRow = { id: 'tick-1', number: 7, title: 'T', type: 'BUG', description: null, comments: [], deletedAt: null };

describe('TicketTransitionsService.autoIndexTicket', () => {
  it('indexes a closed ticket', async () => {
    const { autoIndex, ragService } = build(baseRow);
    autoIndex(project, { id: 'tick-1' });
    await flush();
    expect(ragService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'tick-1' }));
  });

  it('skips a ticket that was deleted before the index ran', async () => {
    const { autoIndex, ragService } = build({ ...baseRow, deletedAt: new Date() });
    autoIndex(project, { id: 'tick-1' });
    await flush();
    expect(ragService.indexDocument).not.toHaveBeenCalled();
  });
});
