export interface VcsConnectionDomain {
  id: string;
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  encryptedToken: string;
  syncMode: string;
  allowedAuthors: string;
  pollingIntervalMs: number;
  webhookSecret: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VcsSyncLogDomain {
  id: string;
  vcsConnectionId: string;
  syncType: string;
  issuesSynced: number;
  issuesSkipped: number;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date;
}

export interface VcsProjectDomain {
  id: string;
  key: string;
  slug: string;
}

export interface VcsConnectionWithProjectDomain extends VcsConnectionDomain {
  project: VcsProjectDomain;
}
