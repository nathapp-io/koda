/**
 * Builds a branch name from project key, ticket number, and title
 * Format: {projectLower}/{projectKey}-{ticketNumber}/{slug}
 */
export function buildBranchName(
  projectKey: string,
  ticketNumber: number,
  title: string,
): string {
  const projectLower = projectKey.toLowerCase();
  const ticketPortion = `${projectKey}-${ticketNumber}`;
  const prefix = `${projectLower}/${ticketPortion}`;

  const slug = title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '');

  const maxSlugLength = 100 - prefix.length - 1;
  const truncatedSlug = slug.slice(0, Math.max(0, maxSlugLength));
  const finalSlug = truncatedSlug.replace(/-+$/, '');

  return `${prefix}/${finalSlug}`;
}
