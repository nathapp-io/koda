/**
 * Permissions P2 US-002: the shared VCS audit contract. `prStateSummary` is the one place a
 * PR-state entry's summary is spelled, so US-003 reuses it instead of building its own string.
 */
import { prStateSummary } from './vcs-audit';

describe('vcs-audit', () => {
  describe('prStateSummary', () => {
    it('names none for a link with no stored state', () => {
      expect(prStateSummary(null, 'open')).toBe('pr none -> open');
    });

    it('names both states when the link already has one', () => {
      expect(prStateSummary('open', 'closed')).toBe('pr open -> closed');
    });
  });
});
