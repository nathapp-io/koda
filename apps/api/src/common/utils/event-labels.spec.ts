import { describe, expect, it, vi } from 'vitest';
import type { EventLabelClient } from './event-labels';
import { readPrincipalNames, readTicketLabels } from './event-labels';

function fakeClient() {
  const userFindMany = vi.fn().mockResolvedValue([]);
  const agentFindMany = vi.fn().mockResolvedValue([]);
  const ticketFindMany = vi.fn().mockResolvedValue([]);
  const client = {
    user: { findMany: userFindMany },
    agent: { findMany: agentFindMany },
    ticket: { findMany: ticketFindMany },
  } as unknown as EventLabelClient;

  return { client, userFindMany, agentFindMany, ticketFindMany };
}

describe('readPrincipalNames', () => {
  it('AC-1: returns a trimmed user name', async () => {
    const fake = fakeClient();
    fake.userFindMany.mockResolvedValue([{ id: 'u1', name: '  Alice ', email: 'alice@example.com' }]);

    await expect(readPrincipalNames(fake.client, ['u1'])).resolves.toEqual(new Map([['u1', 'Alice']]));
  });

  it('AC-2: falls back to the user email local part when name is null', async () => {
    const fake = fakeClient();
    fake.userFindMany.mockResolvedValue([{ id: 'u2', name: null, email: 'bob@example.com' }]);

    await expect(readPrincipalNames(fake.client, ['u2'])).resolves.toEqual(new Map([['u2', 'bob']]));
  });

  it('AC-3: falls back to the user email local part when name is blank', async () => {
    const fake = fakeClient();
    fake.userFindMany.mockResolvedValue([{ id: 'u3', name: '   ', email: 'carol@example.com' }]);

    await expect(readPrincipalNames(fake.client, ['u3'])).resolves.toEqual(new Map([['u3', 'carol']]));
  });

  it('AC-4: returns an agent name', async () => {
    const fake = fakeClient();
    fake.agentFindMany.mockResolvedValue([{ id: 'a1', name: 'codex-bot' }]);

    await expect(readPrincipalNames(fake.client, ['a1'])).resolves.toEqual(new Map([['a1', 'codex-bot']]));
  });

  it('AC-5: omits principals absent from both tables', async () => {
    const fake = fakeClient();

    await expect(readPrincipalNames(fake.client, ['gone'])).resolves.toEqual(new Map());
  });

  it('AC-6: deduplicates ids and drops empty strings in one query per table', async () => {
    const fake = fakeClient();

    await readPrincipalNames(fake.client, ['u1', 'u1', '']);

    expect(fake.userFindMany).toHaveBeenCalledTimes(1);
    expect(fake.userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1'] } },
      select: { id: true, name: true, email: true },
    });
    expect(fake.agentFindMany).toHaveBeenCalledTimes(1);
    expect(fake.agentFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1'] } },
      select: { id: true, name: true },
    });
  });

  it('AC-7: returns an empty map without querying for empty input', async () => {
    const fake = fakeClient();

    await expect(readPrincipalNames(fake.client, [])).resolves.toEqual(new Map());
    expect(fake.userFindMany).not.toHaveBeenCalled();
    expect(fake.agentFindMany).not.toHaveBeenCalled();
  });
});

describe('readTicketLabels', () => {
  it('AC-8: returns the project ticket ref and title', async () => {
    const fake = fakeClient();
    fake.ticketFindMany.mockResolvedValue([
      { id: 't1', number: 34, title: 'Fix login', project: { key: 'SB' } },
    ]);

    await expect(readTicketLabels(fake.client, ['t1'])).resolves.toEqual(
      new Map([['t1', { ref: 'SB-34', title: 'Fix login' }]]),
    );
  });

  it('AC-9: queries by id without excluding soft-deleted tickets', async () => {
    const fake = fakeClient();

    await readTicketLabels(fake.client, ['t1']);

    expect(fake.ticketFindMany).toHaveBeenCalledTimes(1);
    expect(fake.ticketFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['t1'] } },
      select: { id: true, number: true, title: true, project: { select: { key: true } } },
    });
  });

  it('AC-10: returns an empty map without querying for empty input', async () => {
    const fake = fakeClient();

    await expect(readTicketLabels(fake.client, [])).resolves.toEqual(new Map());
    expect(fake.ticketFindMany).not.toHaveBeenCalled();
  });
});
