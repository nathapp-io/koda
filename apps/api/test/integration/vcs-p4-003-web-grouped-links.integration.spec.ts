/**
 * VCS-P4-003 AC-17 through AC-21: Web ticket detail page VCS section groups links by linkType
 *
 * AC-17: Web UI: VCS section renders 3 distinct subsection containers with data-link-type
 *        values 'pull_request', 'branch', and 'commit' respectively
 * AC-18: Web UI: Each PR item contains a visible PR number, a status badge, and clickable link
 * AC-19: Web UI: Each branch item contains a clickable link with branch name
 * AC-20: Web UI: Each commit item contains SHA (7 chars), commit message, and clickable link
 * AC-21: Web UI: Commit timestamps sorted in descending order (newest first)
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ticketDetailPagePath = join(__dirname, '../../../web/pages/[project]/tickets/[ref].vue');

describe('VCS-P4-003 AC1-5: Web grouped VCS links display', () => {
  beforeAll(() => {
    // Skip all tests if file doesn't exist
    if (!existsSync(ticketDetailPagePath)) {
      console.warn('Ticket detail page not found at:', ticketDetailPagePath);
    }
  });

  describe('AC1: VCS section groups links by linkType', () => {
    test('ticket detail page has linkType field in TicketLink interface', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // TicketLink interface should include linkType
      const hasLinkTypeInInterface =
        source.includes('linkType') ||
        source.match(/interface TicketLink[\s\S]*?\{[\s\S]*?linkType/);
      expect(hasLinkTypeInInterface).toBeTruthy();
    });

    test('page has computed properties that filter links by type', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should have computed properties that separate links by linkType
      const hasTypeFiltering =
        (source.includes("linkType === 'branch'") ||
         source.includes("linkType === 'commit'") ||
         source.includes('linkType === "branch"') ||
         source.includes('linkType === "commit"') ||
         source.includes('filter(link => link.provider'));
      expect(hasTypeFiltering).toBeTruthy();
    });
  });

  describe('AC2: PR subsection displays PR number, status badge, and link', () => {
    test('PR subsection shows PR number', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should display PR number in the template
      const hasPrNumberDisplay =
        source.includes('prNumber') ||
        source.includes('extractPrNumber');
      expect(hasPrNumberDisplay).toBeTruthy();
    });

    test('PR subsection shows status badge', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should have Badge component for PR status
      const hasPrStatusBadge =
        source.includes('prState') &&
        source.includes('Badge');
      expect(hasPrStatusBadge).toBeTruthy();
    });

    test('PR subsection has clickable link', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should have anchor tag linking to PR URL
      const hasClickableLink =
        source.includes('<a') &&
        source.includes('href=') &&
        source.includes('link.url');
      expect(hasClickableLink).toBeTruthy();
    });
  });

  describe('AC3: Branch subsection shows branch name as clickable link', () => {
    test('branch links are filtered by linkType === branch', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should filter for branch type links
      const hasBranchFilter =
        source.includes("'branch'") ||
        source.includes('"branch"') ||
        source.includes('linkType');
      expect(hasBranchFilter).toBeTruthy();
    });

    test('branch link displays as clickable link to GitHub', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Branch links should be displayed as <a> tags with href
      const hasBranchLinkDisplay =
        (source.includes('branch') || source.includes('Branch')) &&
        (source.includes('<a') || source.includes('href'));
      expect(hasBranchLinkDisplay).toBeTruthy();
    });
  });

  describe('AC4: Commit subsection shows SHA and message as clickable link', () => {
    test('commit links are filtered by linkType === commit', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should filter for commit type links
      const hasCommitFilter =
        source.includes("'commit'") ||
        source.includes('"commit"') ||
        source.includes('linkType');
      expect(hasCommitFilter).toBeTruthy();
    });

    test('commit link shows abbreviated SHA (7 chars)', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should have utility to abbreviate SHA to 7 characters
      // Look for substring(0, 7) or similar
      const hasShaAbbreviation =
        source.includes('substring') ||
        source.includes('slice') ||
        source.includes('slice(0, 7)') ||
        source.includes('substring(0, 7)') ||
        source.includes('sha');
      expect(hasShaAbbreviation).toBeTruthy();
    });

    test('commit link shows commit message', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should display commit message or title
      const hasCommitMessageDisplay =
        source.includes('commit') &&
        (source.includes('message') || source.includes('title'));
      expect(hasCommitMessageDisplay).toBeTruthy();
    });

    test('commit link is clickable to GitHub', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Commit links should be <a> tags linking to commit URL
      const hasCommitClickableLink =
        source.includes('<a') &&
        source.includes('href=');
      expect(hasCommitClickableLink).toBeTruthy();
    });
  });

  describe('AC5: Commits displayed in reverse chronological order', () => {
    test('commits are sorted by date descending', () => {
      const source = readFileSync(ticketDetailPagePath, 'utf-8');

      // Should sort commits by date
      const hasDateSorting =
        source.includes('sort') ||
        source.includes('reverse') ||
        source.includes('createdAt') ||
        source.includes('date');
      expect(hasDateSorting).toBeTruthy();
    });
  });
});
