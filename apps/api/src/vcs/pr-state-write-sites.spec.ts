/**
 * M12: TicketLink.prState is written through exactly one conditional update,
 * PrismaVcsRepository.updateTicketLinkWithPrState, which never overwrites
 * `merged`. This spec fails when any other ticketLink update/upsert call
 * appears in src, so a reviewer must decide whether it may touch prState.
 *
 * Best-effort tripwire, not a proof: it matches Prisma client method calls. Raw
 * SQL (`$executeRaw`) that writes prState would bypass it, so this complements —
 * never replaces — review of new write paths.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sourceFiles } from '../common/test-helpers/source-files';

const SRC_ROOT = join(__dirname, '..');
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
      'vcs/prisma-vcs.repository.ts:updateMany',
      'vcs/prisma-vcs.repository.ts:upsert',
    ]);
  });

  it('writes prState only in the conditional updateMany', () => {
    expect(sites.filter((s) => s.args.includes('prState')).map((s) => s.site)).toEqual([
      'vcs/prisma-vcs.repository.ts:updateMany',
    ]);
  });

  it('the conditional updateMany skips merged rows but not NULL ones', () => {
    const update = sites.find((s) => s.site.endsWith(':updateMany'));
    expect(update?.args).toContain("prState: { not: 'merged' }");
    expect(update?.args).toContain('prState: null');
  });
});
