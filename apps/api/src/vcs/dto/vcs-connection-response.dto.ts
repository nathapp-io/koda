export class VcsConnectionResponseDto {
  id: string;
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  syncMode: string;
  lastSyncedAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Note: token is intentionally not included in the response DTO
}
