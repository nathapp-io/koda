/**
 * Branch name building utility for VCS integration.
 * Creates standardized branch names from project key, ticket number, and title.
 */
export function buildBranchName(
  projectKey: string,
  ticketNumber: number,
  ticketTitle: string,
): string {
  const slug = ticketTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100 - projectKey.length - ticketNumber.toString().length - 10);

  const prefix = projectKey.toLowerCase();
  const ticketRef = `${projectKey}-${ticketNumber}`;

  return `${prefix}/${ticketRef}/${slug}`;
}
