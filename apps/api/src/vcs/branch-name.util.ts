/**
 * Branch name building utility for VCS integration.
 * Creates standardized branch names from project key, ticket number, and title.
 */
export function buildBranchName(
  projectKey: string,
  ticketNumber: number,
  ticketTitle: string,
): string {
  const ticketRef = `${projectKey}-${ticketNumber}`;
  const prefix = `koda/${ticketRef}`;
  const maxSlugLength = Math.max(0, 100 - prefix.length - 1);

  const slug = ticketTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxSlugLength)
    .replace(/-+$/g, '');

  return `${prefix}/${slug}`;
}
