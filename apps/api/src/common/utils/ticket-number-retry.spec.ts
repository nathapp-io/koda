import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import {
  isTicketNumberConflict,
  runWithTicketNumberRetry,
  TICKET_NUMBER_MAX_ATTEMPTS,
} from './ticket-number-retry';

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function txManager(inTransaction = false): ITransactionManager & { run: jest.Mock } {
  return {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: () => inTransaction,
  } as unknown as ITransactionManager & { run: jest.Mock };
}

const noSleep = { sleep: jest.fn(() => Promise.resolve()), random: () => 0 };

describe('isTicketNumberConflict', () => {
  it('matches P2002 with an array target containing number', () => {
    expect(isTicketNumberConflict(p2002(['projectId', 'number']))).toBe(true);
  });

  it('matches P2002 with a constraint-name target containing number', () => {
    expect(isTicketNumberConflict(p2002('Ticket_projectId_number_key'))).toBe(true);
  });

  it('ignores P2002 on another unique constraint', () => {
    expect(isTicketNumberConflict(p2002(['externalVcsId']))).toBe(false);
  });

  it('ignores non-Prisma errors and other codes', () => {
    expect(isTicketNumberConflict(new Error('boom'))).toBe(false);
    const p2025 = new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' });
    expect(isTicketNumberConflict(p2025)).toBe(false);
  });
});

describe('runWithTicketNumberRetry', () => {
  it('returns the first successful result, one transaction per attempt', async () => {
    const tx = txManager();
    const work = jest
      .fn()
      .mockRejectedValueOnce(p2002(['projectId', 'number']))
      .mockResolvedValueOnce('ticket');

    await expect(runWithTicketNumberRetry(tx, work, noSleep)).resolves.toBe('ticket');
    expect(tx.run).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts with a 409', async () => {
    const tx = txManager();
    const work = jest.fn().mockRejectedValue(p2002(['projectId', 'number']));

    const err = await runWithTicketNumberRetry(tx, work, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(tx.run).toHaveBeenCalledTimes(TICKET_NUMBER_MAX_ATTEMPTS);
  });

  it('propagates a P2002 on another constraint untouched and does not retry', async () => {
    const tx = txManager();
    const other = p2002(['externalVcsId']);
    const work = jest.fn().mockRejectedValue(other);

    await expect(runWithTicketNumberRetry(tx, work, noSleep)).rejects.toBe(other);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  it('inside an outer transaction runs once and maps a conflict to 409', async () => {
    const tx = txManager(true);
    const work = jest.fn().mockRejectedValue(p2002(['projectId', 'number']));

    const err = await runWithTicketNumberRetry(tx, work, noSleep).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  it('backs off with jitter growing per attempt', async () => {
    const tx = txManager();
    const sleep = jest.fn(() => Promise.resolve());
    const work = jest
      .fn()
      .mockRejectedValueOnce(p2002(['projectId', 'number']))
      .mockRejectedValueOnce(p2002(['projectId', 'number']))
      .mockResolvedValueOnce('ok');

    await runWithTicketNumberRetry(tx, work, { sleep, random: () => 1 });
    // attempt × (10 + 40 × random): attempt 1 → 50, attempt 2 → 100
    expect(sleep.mock.calls).toEqual([[50], [100]]);
  });
});
