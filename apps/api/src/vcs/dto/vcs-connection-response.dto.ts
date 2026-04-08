export class VcsConnectionResponseDto {
  id: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  syncMode: string;
  allowedAuthors: string[];
  pollingIntervalMs: number;
  lastSyncedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
