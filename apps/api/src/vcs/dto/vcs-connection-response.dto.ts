export class VcsConnectionResponseDto {
  id: string;
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  syncMode: string;
  allowedAuthors: string[];
  pollingIntervalMs: number;
  webhookSecretConfigured: boolean;
  lastSyncedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** M9: the create response carries the generated webhook secret, once. */
export class VcsConnectionCreatedResponseDto extends VcsConnectionResponseDto {
  webhookSecret: string;
}

/** M9: set only when this update generated a secret (a legacy row switching to webhook mode). */
export class VcsConnectionUpdatedResponseDto extends VcsConnectionResponseDto {
  webhookSecret?: string;
}

/** M9: a rotated webhook secret, returned once. */
export class WebhookSecretResponseDto {
  webhookSecret: string;
}
