// Ticket types and priorities aligned with API enum definitions
// Source of truth: apps/api/src/common/enums.ts

export const TicketType = ['BUG', 'ENHANCEMENT', 'TASK', 'QUESTION'] as const
export type TicketType = (typeof TicketType)[number]

export const Priority = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Priority = (typeof Priority)[number]

export const TICKET_TYPES = TicketType
export const PRIORITIES = Priority
