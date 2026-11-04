import type { RulingDisposition } from './fleet-pr-ruling.domain';

/** Inspect one line only; later lines remain evidence, never additional commands. */
export function parseRulingText(text: string): { disposition: RulingDisposition; reason: string; sha?: string } | null {
  // nax's ruling file, runner, tools and web bound strings in UTF-16 code units.
  // Guard here as well as the REST DTO: @Length counts code points instead.
  if (text.length < 1 || text.length > 2000) return null;
  const line = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
  const fixed = /^fixed\s+([a-f0-9]{7,40})(?:\s*(?:—|-|:)\s*(.*))?$/i.exec(line);
  if (fixed) return { disposition: 'fixed', sha: fixed[1], reason: (fixed[2] ?? '').trim() };
  const evidence = /^(waive|waived|override|overridden|confirm|confirmed):\s*(.+)$/i.exec(line);
  if (evidence) {
    const keyword = evidence[1].toLowerCase();
    const disposition = keyword.startsWith('waiv') ? 'waived' : keyword.startsWith('over') ? 'overridden' : 'confirmed';
    const reason = evidence[2].trim();
    return reason ? { disposition, reason } : null;
  }
  const verified = /^(?:verify|verified)(?::\s*(.*))?$/i.exec(line);
  return verified ? { disposition: 'verified', reason: verified[1]?.trim() || 'verified' } : null;
}
