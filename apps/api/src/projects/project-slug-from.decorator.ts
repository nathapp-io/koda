import { SetMetadata } from '@nestjs/common';

/**
 * Track 3 Slice 4: where ProjectMembershipGuard finds the project slug on a
 * route that carries it outside `:slug`. The code-intel read routes take
 * `?projectSlug=`; without this the guard never runs on them.
 */
export const PROJECT_SLUG_FROM_KEY = 'koda:projectSlugFrom';

export interface ProjectSlugSource {
  source: 'query';
  key: string;
}

export const ProjectSlugFrom = (source: 'query', key: string) =>
  SetMetadata<string, ProjectSlugSource>(PROJECT_SLUG_FROM_KEY, { source, key });
