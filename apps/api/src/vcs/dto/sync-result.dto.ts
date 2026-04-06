export class SyncResultDto {
  issuesSynced: number;
  issuesSkipped: number;
  createdTickets: Array<{
    id: string;
    projectKey: string;
    number: number;
  }>;
  errors?: string[];
}
