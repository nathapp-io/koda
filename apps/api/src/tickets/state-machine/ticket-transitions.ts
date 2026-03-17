import { BadRequestException } from '@nestjs/common';
import { TicketStatus, CommentType } from '@prisma/client';

// Define transition rules: from → to → required comment type (or undefined if no comment needed)
type TransitionRule = {
  [from in TicketStatus]?: {
    [to in TicketStatus]?: CommentType | 'NONE';
  };
};

const TRANSITION_RULES: TransitionRule = {
  [TicketStatus.CREATED]: {
    [TicketStatus.VERIFIED]: CommentType.VERIFICATION,
    [TicketStatus.REJECTED]: CommentType.GENERAL,
  },
  [TicketStatus.VERIFIED]: {
    [TicketStatus.IN_PROGRESS]: 'NONE',
    [TicketStatus.REJECTED]: CommentType.GENERAL,
  },
  [TicketStatus.IN_PROGRESS]: {
    [TicketStatus.VERIFY_FIX]: CommentType.FIX_REPORT,
    [TicketStatus.VERIFIED]: CommentType.GENERAL,
  },
  [TicketStatus.VERIFY_FIX]: {
    [TicketStatus.CLOSED]: CommentType.REVIEW,
    [TicketStatus.IN_PROGRESS]: CommentType.REVIEW,
  },
};

/**
 * Validates a ticket status transition.
 * Throws BadRequestException if:
 * - No rule exists for the from→to pair
 * - A comment type is required but missing or wrong
 */
export function validateTransition(
  from: TicketStatus,
  to: TicketStatus,
  commentType?: CommentType,
): void {
  // Check if transition rule exists
  const fromRules = TRANSITION_RULES[from];
  if (!fromRules) {
    throw new BadRequestException(`No transitions allowed from status ${from}`);
  }

  const requiredCommentType = fromRules[to];
  if (requiredCommentType === undefined) {
    throw new BadRequestException(
      `Transition from ${from} to ${to} is not allowed`,
    );
  }

  // Check comment type requirement
  if (requiredCommentType === 'NONE') {
    // No comment required
    return;
  }

  // Comment is required
  if (!commentType) {
    throw new BadRequestException(
      `Transition from ${from} to ${to} requires a ${requiredCommentType} comment`,
    );
  }

  if (commentType !== requiredCommentType) {
    throw new BadRequestException(
      `Transition from ${from} to ${to} requires a ${requiredCommentType} comment, but got ${commentType}`,
    );
  }
}
