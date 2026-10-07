import type { VcsPrStatus } from './types';

/** TicketLink.prState for a provider PR status: draft | open | merged | closed (other states pass through). */
export function mapPrState(pr: Pick<VcsPrStatus, 'merged' | 'state' | 'draft'>): string {
  if (pr.merged) return 'merged';
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open';
  return pr.state === 'closed' ? 'closed' : pr.state;
}
