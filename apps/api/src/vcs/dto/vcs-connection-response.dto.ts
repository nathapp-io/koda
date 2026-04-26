export class VcsConnectionResponseDto {
  id: string;
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  syncMode: string;
  allowedAuthors: string[];
  pollingIntervalMs: number;
  webhookSecret: string | null;
  lastSyncedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
