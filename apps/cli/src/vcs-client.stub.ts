/**
 * Minimal VCS client stubs for test compilation.
 * These are temporary stubs until the OpenAPI client is regenerated.
 * Do NOT use in actual code - these are only for test imports.
 */

export interface VcsConnectionResponseDto {
  id: string;
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  syncMode: string;
  allowedAuthors: string;
  pollingIntervalMs: number;
  webhookSecret?: string;
  lastSyncedAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function vcsControllerCreateConnection(_options: {
  slug: string;
  requestBody?: {
    provider: string;
    token: string;
    repoUrl: string;
    syncMode?: string;
    webhookSecret?: string;
  };
}): Promise<VcsConnectionResponseDto> {
  throw new Error('Not implemented - stub only');
}

export async function vcsControllerGetConnection(_options: {
  slug: string;
}): Promise<VcsConnectionResponseDto> {
  throw new Error('Not implemented - stub only');
}

export async function vcsControllerDeleteConnection(_options: {
  slug: string;
}): Promise<void> {
  throw new Error('Not implemented - stub only');
}
