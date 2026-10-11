import type { Mock } from 'vitest';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { FleetTicketsService } from './fleet-tickets.service';

describe('FleetTicketsService.resolveForDispatch (C9 D450)', () => {
  const ticket = (number: number, status = 'CREATED', deletedAt: Date | null = null) =>
    ({ id: `t${number}`, number, title: `T${number}`, status, deletedAt });
  let repo: { findProject: Mock; findTicketsByNumbers: Mock };
  let service: FleetTicketsService;

  beforeEach(() => {
    repo = { findProject: vi.fn().mockResolvedValue({ key: 'WEB', slug: 'web' }), findTicketsByNumbers: vi.fn() };
    service = new FleetTicketsService(repo as never, { run: (fn: () => unknown) => fn() } as never, {} as never);
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

describe('FleetTicketsService list and unlink (C9 §2.2-§2.3)', () => {
  let repo: { findProject: Mock; findTicketByRef: Mock; findJobsForTicket: Mock; unlink: Mock };
  let events: { record: Mock };
  let service: FleetTicketsService;
  const row = {
    id: 'j1', command: 'RUN', feature: 'f', state: 'COMPLETED', stateReason: null, escalationReason: null,
    resultBranch: 'feat/f', resultSha: 'a'.repeat(40), resultPrUrl: 'https://github.com/acme/app/pull/1',
    costSpentUsd: '0.5', costCarriedUsd: '0.25', queuedAt: new Date('2026-10-06T00:00:00Z'), finishedAt: null,
  };

  beforeEach(() => {
    repo = {
      findProject: vi.fn().mockResolvedValue({ key: 'WEB', slug: 'web' }),
      findTicketByRef: vi.fn().mockResolvedValue({ id: 't1' }),
      findJobsForTicket: vi.fn().mockResolvedValue([row]),
      unlink: vi.fn().mockResolvedValue(true),
    };
    events = { record: vi.fn() };
    service = new FleetTicketsService(repo as never, { run: (fn: () => unknown) => fn() } as never, events as never);
  });

  it('lists up to 50 jobs with the summed cost', async () => {
    const [dto] = await service.listForTicket('p', 'web-1');
    expect(repo.findTicketByRef).toHaveBeenCalledWith('p', 'WEB', 'web-1');
    expect(repo.findJobsForTicket).toHaveBeenCalledWith('t1', 50);
    expect(dto).toEqual(expect.objectContaining({ id: 'j1', costUsd: '0.7500', queuedAt: '2026-10-06T00:00:00.000Z', finishedAt: null }));
  });

  it('404s for an unknown ticket', async () => {
    repo.findTicketByRef.mockResolvedValue(null);
    await expect(service.listForTicket('p', 'WEB-9')).rejects.toThrow();
  });

  it('unlinks and records TICKET_UPDATED; 404s when not linked', async () => {
    await service.unlink('p', 'WEB-1', 'j1', 'u1');
    expect(repo.unlink).toHaveBeenCalledWith('j1', 't1');
    expect(events.record).toHaveBeenCalledWith({ projectId: 'p', ticketId: 't1', action: 'TICKET_UPDATED', actorId: 'u1', data: { fleetJobUnlinked: 'j1' } });
    repo.unlink.mockResolvedValue(false);
    await expect(service.unlink('p', 'WEB-1', 'j1', 'u1')).rejects.toThrow();
  });
});
