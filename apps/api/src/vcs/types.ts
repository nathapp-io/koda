/**
 * Represents a VCS issue from any provider (GitHub, GitLab, etc.)
 */
export interface VcsIssue {
  number: number;
  title: string;
  body: string | null;
  authorLogin: string;
  url: string;
  labels: string[];
  createdAt: Date;
}
