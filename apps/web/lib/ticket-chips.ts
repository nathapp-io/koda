/**
 * Token-based ticket chip styling, shared by the board card, the ticket header, the board
 * columns and the home dashboard. One definition so the chips cannot drift apart again
 * (MASTER-PLAN §6 slice 3; replaces the per-component STATUS_DOT/PRIORITY_DOT copies and
 * TicketCard's palette-colored typeBadgeClass/priorityClass helpers).
 *
 * State is never color alone: these only style the dot/outline — the caller always renders
 * the i18n label next to them.
 */

export const TICKET_CHIP_CLASS =
  'inline-flex items-center gap-1.5 h-[26px] rounded-full border border-border bg-card px-2.5 text-xs font-medium'

export const TICKET_DOT_CLASS = 'h-2 w-2 rounded-full'

export const STATUS_DOT: Record<string, string> = {
  CREATED: 'bg-status-todo',
  VERIFIED: 'bg-status-todo',
  IN_PROGRESS: 'bg-status-active',
  VERIFY_FIX: 'bg-status-review',
  CLOSED: 'bg-status-done',
  REJECTED: 'bg-status-rejected',
}

export const PRIORITY_DOT: Record<string, string> = {
  CRITICAL: 'bg-priority-critical',
  HIGH: 'bg-priority-high',
  MEDIUM: 'bg-priority-medium',
  LOW: 'bg-priority-low',
}

/** Tint applied to a chip's own border/text; the card keeps its token background. */
export const TYPE_CLASS: Record<string, string> = {
  BUG: 'text-status-rejected border-status-rejected/40',
  ENHANCEMENT: 'text-status-active border-status-active/40',
  TASK: 'text-muted-foreground',
  QUESTION: 'text-muted-foreground',
}

/** The card-wide left stripe (TicketCard). */
export const PRIORITY_STRIPE: Record<string, string> = {
  CRITICAL: 'border-l-priority-critical',
  HIGH: 'border-l-priority-high',
  MEDIUM: 'border-l-priority-medium',
  LOW: 'border-l-priority-low',
}

const FALLBACK_DOT = 'bg-muted-foreground'

export function statusDotClass(status: string): string {
  return STATUS_DOT[status] ?? FALLBACK_DOT
}

export function priorityDotClass(priority: string): string {
  return PRIORITY_DOT[priority] ?? FALLBACK_DOT
}

export function priorityStripeClass(priority: string): string {
  return PRIORITY_STRIPE[priority] ?? PRIORITY_STRIPE.LOW
}

export function typeChipClass(type: string): string[] {
  return [TICKET_CHIP_CLASS, TYPE_CLASS[type] ?? TYPE_CLASS.TASK]
}
