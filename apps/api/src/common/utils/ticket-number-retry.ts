import { HttpException, HttpStatus } from '@nestjs/common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { isUniqueViolation } from './prisma-errors';

/**
 * Ticket numbers are allocated as MAX(number)+1 per project. On Postgres two
 * concurrent creators can read the same MAX; the @@unique([projectId, number])
 * index rejects the loser with P2002. Postgres aborts the loser's transaction,
 * so the retry must start a NEW transaction — never retry inside the failed one.
 *
 * 10 attempts: N concurrent creators need up to N rounds in the worst case.
 */
export const TICKET_NUMBER_MAX_ATTEMPTS = 10;

export interface TicketNumberRetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function conflict(): HttpException {
  // Koda's 409 convention (no conflict AppException exists in @nathapp/nestjs-common).
  return new HttpException('Ticket number allocation conflicted; retry the request', HttpStatus.CONFLICT);
}

export function isTicketNumberConflict(error: unknown): boolean {
  return isUniqueViolation(error, 'number');
}

export async function runWithTicketNumberRetry<T>(
  txManager: ITransactionManager,
  work: () => Promise<T>,
  options: TicketNumberRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  // PrismaTransactionManager.run() joins an active transaction, so a retry
  // there would reuse the aborted transaction. Run once and report 409.
  const maxAttempts = txManager.isInTransaction()
    ? 1
    : (options.maxAttempts ?? TICKET_NUMBER_MAX_ATTEMPTS);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await txManager.run(work);
    } catch (error) {
      if (!isTicketNumberConflict(error)) throw error;
      if (attempt >= maxAttempts) throw conflict();
      await sleep(attempt * Math.round(10 + 40 * random()));
    }
  }
}
