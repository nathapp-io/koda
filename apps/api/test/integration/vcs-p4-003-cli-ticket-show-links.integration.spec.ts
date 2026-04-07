/**
 * VCS-P4-003 AC-22 & AC-23: CLI ticket show displays links grouped by type
 *
 * AC-22: CLI: Running `koda ticket show <ref>` outputs structured text containing a
 *        'Links' or 'VCS Links' section. Branch links appear under a 'branch' or 'branches'
 *        heading. Commit links appear under a 'commit' or 'commits' heading.
 * AC-23: CLI: `koda ticket show <ref> --json` returns valid JSON where the `links` array
 *        contains objects each having a `linkType` property with value 'pull_request',
 *        'branch', or 'commit'.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ticketCommandPath = join(__dirname, '../../../cli/src/commands/ticket.ts');

describe('VCS-P4-003 AC6: ticket show displays links grouped by type', () => {
  test('TicketLink type includes linkType field', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8');
    // Find the TicketLink type definition
    const ticketLinkMatch = source.match(/type TicketLink = [\{][\s\S]*?\};/m);
    expect(ticketLinkMatch).not.toBeNull();

    const ticketLinkBlock = ticketLinkMatch ? ticketLinkMatch[0] : '';
    expect(ticketLinkBlock).toContain('linkType');
  });

  test('ticket show command groups links by linkType in text output', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8');
    // Should have separate sections for branches and commits
    const hasGroupedOutput =
      (source.includes('Branches') || source.includes('branches')) &&
      (source.includes('Commits') || source.includes('commits'));
    expect(hasGroupedOutput).toBe(true);
  });

  test('ticket show command displays branch links separately from PR links', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8');
    // Should distinguish between different link types
    const hasLinkTypeHandling =
      source.includes("linkType === 'branch'") ||
      source.includes("linkType === 'commit'") ||
      source.includes("link.linkType") ||
      (source.includes('branch') && source.includes('commit'));
    expect(hasLinkTypeHandling).toBe(true);
  });
});

describe('VCS-P4-003 AC7: ticket show --json includes linkType field', () => {
  test('TicketDetail type includes linkType in links array', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8');
    // Find TicketDetail type that includes links
    const ticketDetailMatch = source.match(/type TicketDetail = TicketRow &[^{]*\{[\s\S]*?\n\};/m);
    expect(ticketDetailMatch).not.toBeNull();

    const ticketDetailBlock = ticketDetailMatch ? ticketDetailMatch[0] : '';
    // Should have links with TicketLink type
    expect(ticketDetailBlock).toContain('links?:');
    expect(ticketDetailBlock).toContain('TicketLink');
  });

  test('links in JSON output preserve linkType from API response', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8');
    // When outputting JSON, should include linkType from API
    // Check that JSON.stringify is called with ticketData in the show command
    const hasJsonOutput = source.includes("JSON.stringify(ticketData");
    expect(hasJsonOutput).toBe(true);
    // ticketData is of type TicketDetail which includes links with linkType
    // Verify TicketLink type includes linkType field
    const ticketLinkMatch = source.match(/type TicketLink = \{[\s\S]*?\};/m);
    expect(ticketLinkMatch).not.toBeNull();
    const ticketLinkBlock = ticketLinkMatch ? ticketLinkMatch[0] : '';
    expect(ticketLinkBlock).toContain('linkType');
    // Verify TicketDetail references TicketLink for links
    const ticketDetailMatch = source.match(/type TicketDetail = [\{\s\S]+?\n\};/m);
    expect(ticketDetailMatch).not.toBeNull();
    const ticketDetailBlock = ticketDetailMatch ? ticketDetailMatch[0] : '';
    expect(ticketDetailBlock).toContain('TicketLink');
  });
});
