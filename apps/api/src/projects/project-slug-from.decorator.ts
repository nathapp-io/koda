import { SetMetadata } from '@nestjs/common';

/**
 * Selects where ProjectMembershipGuard finds a slug outside `:slug`: a query
 * parameter (code-intel reads use `?projectSlug=`) or a body field (code-intel
 * indexing uses `projectSlug`). Path slugs take precedence over either source.
 */
export const PROJECT_SLUG_FROM_KEY = 'koda:projectSlugFrom';

export interface ProjectSlugSource {
  source: 'query' | 'body';
  key: string;
}

export const ProjectSlugFrom = (source: 'query' | 'body', key: string) =>
  SetMetadata<string, ProjectSlugSource>(PROJECT_SLUG_FROM_KEY, { source, key });
