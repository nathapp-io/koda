import { ValidationAppException } from '@nathapp/nestjs-common';
import { FleetTicketsService } from './fleet-tickets.service';

describe('FleetTicketsService.resolveForDispatch (C9 D450)', () => {
  const ticket = (number: number, status = 'CREATED', deletedAt: Date | null = null) =>
    ({ id: `t${number}`, number, title: `T${number}`, status, deletedAt });
  let repo: { findProject: jest.Mock; findTicketsByNumbers: jest.Mock };
  let service: FleetTicketsService;

  beforeEach(() => {
    repo = { findProject: jest.fn().mockResolvedValue({ key: 'WEB', slug: 'web' }), findTicketsByNumbers: jest.fn() };
    service = new FleetTicketsService(repo as never, { run: (fn: () => unknown) => fn() } as never);
  });

  it('returns [] without touching the DB when no refs are given', async () => {
    await expect(service.resolveForDispatch('p', undefined)).resolves.toEqual([]);
    await expect(service.resolveForDispatch('p', [])).resolves.toEqual([]);
    expect(repo.findProject).not.toHaveBeenCalled();
  });

  it('resolves refs in request order', async () => {
    repo.findTicketsByNumbers.mockResolvedValue([ticket(2, 'VERIFIED'), ticket(1)]);
    await expect(service.resolveForDispatch('p', ['web-1', 'WEB-2'])).resolves.toEqual([
      { id: 't1', ref: 'WEB-1', title: 'T1', status: 'CREATED' },
      { id: 't2', ref: 'WEB-2', title: 'T2', status: 'VERIFIED' },
    ]);
  });

  it.each([
    ['missing', []],
    ['deleted', [ticket(1, 'CREATED', new Date())]],
    ['CLOSED', [ticket(1, 'CLOSED')]],
    ['REJECTED', [ticket(1, 'REJECTED')]],
  ])('refuses a %s ticket with 400 naming it', async (_label, rows) => {
    repo.findTicketsByNumbers.mockResolvedValue(rows);
    const error = await service.resolveForDispatch('p', ['WEB-1']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationAppException);
    expect(JSON.stringify(error)).toContain('ticket WEB-1');
  });
});
