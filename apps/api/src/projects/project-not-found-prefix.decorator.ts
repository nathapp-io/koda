import { SetMetadata } from '@nestjs/common';

export const PROJECT_NOT_FOUND_PREFIX = 'koda:projectNotFoundPrefix';
/** Selects a route's existing missing-project translation without bypassing membership checks. */
export const ProjectNotFoundPrefix = (prefix: 'projects' | 'rag') => SetMetadata(PROJECT_NOT_FOUND_PREFIX, prefix);
