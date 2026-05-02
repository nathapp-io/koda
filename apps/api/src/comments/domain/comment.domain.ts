export interface CommentDomain {
  id: string;
  ticketId: string;
  body: string;
  type: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const COMMENT_REPOSITORY = Symbol('COMMENT_REPOSITORY');
