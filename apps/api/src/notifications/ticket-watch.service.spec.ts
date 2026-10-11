import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketWatchService } from './ticket-watch.service';

function setup(ticketId: string | null = 't1') {
  const repo = {
    findTicketIdByRef: vi.fn().mockResolvedValue(ticketId),
    watch: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn().mockResolvedValue(undefined),
    state: vi.fn().mockResolvedValue({ watching: true, count: 2 }),
  };
  return { repo, service: new TicketWatchService(repo as never) };
}

describe('TicketWatchService (S4a §3, D502)', () => {
  it('watch un-mutes then returns the state', async () => {
    const { service, repo } = setup();
    await expect(service.watch('p1', 'KODA-1', 'u1')).resolves.toEqual({ watching: true, count: 2 });
    expect(repo.findTicketIdByRef).toHaveBeenCalledWith('p1', 'KODA-1');
    expect(repo.watch).toHaveBeenCalledWith('t1', 'u1');
  });

  it('unwatch mutes then returns the state', async () => {
    const { service, repo } = setup();
    repo.state.mockResolvedValueOnce({ watching: false, count: 1 });
    await expect(service.unwatch('p1', 'KODA-1', 'u1')).resolves.toEqual({ watching: false, count: 1 });
    expect(repo.unwatch).toHaveBeenCalledWith('t1', 'u1');
  });

  it('404s an unknown or deleted ticket without writing', async () => {
    const { service, repo } = setup(null);
    await expect(service.watch('p1', 'KODA-404', 'u1')).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(service.state('p1', 'KODA-404', 'u1')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.watch).not.toHaveBeenCalled();
  });
});
