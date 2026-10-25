/**
 * M12: TicketLink.prState is written through exactly one conditional write,
 * PrismaVcsRepository.updateTicketLinkWithPrState, which never overwrites
 * `merged`. This spec fails when any other ticketLink update/upsert call
 * appears in src, so a reviewer must decide whether it may touch prState.
 *
 * Review B1: that write reads the stored state under the row lock (`SELECT … FOR UPDATE`) in the same
 * transaction, so its reported `previousState` — what the audit entry's change detection and summary
 * use — is the state it really replaced, not a snapshot taken before the transaction.
 *
 * Best-effort tripwire, not a proof: it matches Prisma client method calls. Raw
 * SQL (`$executeRaw`) that writes prState would bypass it, so this complements —
 * never replaces — review of new write paths. The fleet PR-link `updateMany`
 * (C9 D455) sets `jobId` only.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sourceFiles } from '../common/test-helpers/source-files';

const SRC_ROOT = join(__dirname, '..');
const REPOSITORY = join(__dirname, 'prisma-vcs.repository.ts');
const WRITE_CALL = /\.ticketLink\.(update|updateMany|upsert)\(/g;

/** The call's argument text, from its opening paren to the matching close. */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

const sites = sourceFiles(SRC_ROOT).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(WRITE_CALL)].map((match) => ({
    site: `${relative(SRC_ROOT, file)}:${match[1]}`,
    args: callArguments(source, (match.index ?? 0) + match[0].length - 1),
  }));
});

describe('TicketLink prState write sites (M12)', () => {
  it('has exactly the reviewed ticketLink update/upsert call sites', () => {
    expect(sites.map((s) => s.site).sort()).toEqual([
      'fleet/tickets/prisma-fleet-tickets.repository.ts:updateMany',
      'vcs/prisma-vcs.repository.ts:update',
      'vcs/prisma-vcs.repository.ts:upsert',
    ]);
  });

  it('writes prState only in the conditional update', () => {
    expect(sites.filter((s) => s.args.includes('prState')).map((s) => s.site)).toEqual([
      'vcs/prisma-vcs.repository.ts:update',
    ]);
  });

  it('the conditional update locks the row first and skips merged rows', () => {
    const source = readFileSync(REPOSITORY, 'utf8');
    const lockedRead = source.indexOf('FOR UPDATE');
    const write = source.indexOf('ticketLink.update(');

    expect(lockedRead).toBeGreaterThan(-1);
    expect(lockedRead).toBeLessThan(write);
    // The lock is what makes `previousState` authoritative; the guard is what keeps `merged` terminal.
    expect(source).toContain('previousState === \'merged\'');
    expect(source.indexOf('previousState === \'merged\'')).toBeLessThan(write);
  });
});
