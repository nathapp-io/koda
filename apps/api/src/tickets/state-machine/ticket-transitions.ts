import { TicketStatus, CommentType } from '../../common/enums';
import { ValidationAppException } from '@nathapp/nestjs-common';

// Define transition rules: from → to → required comment type (or undefined if no comment needed)
type TransitionRule = {
  [from in TicketStatus]?: {
    [to in TicketStatus]?: CommentType | 'NONE';
  };
};

const TRANSITION_RULES: TransitionRule = {
  [TicketStatus.CREATED]: {
    [TicketStatus.VERIFIED]: CommentType.VERIFICATION,
    [TicketStatus.IN_PROGRESS]: 'NONE',
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
    throw new ValidationAppException();
  }

  const requiredCommentType = fromRules[to];
  if (requiredCommentType === undefined) {
    throw new ValidationAppException();
  }

  // Check comment type requirement
  if (requiredCommentType === 'NONE') {
    // No comment required
    return;
  }

  // Comment is required
  if (!commentType) {
    throw new ValidationAppException();
  }

  if (commentType !== requiredCommentType) {
    throw new ValidationAppException();
  }
}
