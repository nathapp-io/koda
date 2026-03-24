/**
 * Local TypeScript enum definitions for the Koda API.
 * SQLite does not support native Prisma enums, so these are defined here
 * as const objects with string literal types.
 */

export const TicketStatus = {
  CREATED: 'CREATED',
  VERIFIED: 'VERIFIED',
  IN_PROGRESS: 'IN_PROGRESS',
  VERIFY_FIX: 'VERIFY_FIX',
  CLOSED: 'CLOSED',
  REJECTED: 'REJECTED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const TicketType = {
  BUG: 'BUG',
  ENHANCEMENT: 'ENHANCEMENT',
  TASK: 'TASK',
  QUESTION: 'QUESTION',
} as const;
export type TicketType = (typeof TicketType)[keyof typeof TicketType];

export const Priority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const CommentType = {
  GENERAL: 'GENERAL',
  VERIFICATION: 'VERIFICATION',
  FIX_REPORT: 'FIX_REPORT',
  REVIEW: 'REVIEW',
  STATUS_CHANGE: 'STATUS_CHANGE',
} as const;
export type CommentType = (typeof CommentType)[keyof typeof CommentType];

export const ActivityType = {
  STATUS_CHANGE: 'STATUS_CHANGE',
  ASSIGNMENT: 'ASSIGNMENT',
  COMMENT: 'COMMENT',
  LABEL_CHANGE: 'LABEL_CHANGE',
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export const AgentRole = {
  VERIFIER: 'VERIFIER',
  DEVELOPER: 'DEVELOPER',
  REVIEWER: 'REVIEWER',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const AutoAssignMode = { OFF: 'OFF', SUGGEST: 'SUGGEST', AUTO: 'AUTO' } as const;
export type AutoAssignMode = typeof AutoAssignMode[keyof typeof AutoAssignMode];
