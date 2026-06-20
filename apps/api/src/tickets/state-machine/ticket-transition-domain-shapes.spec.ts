/**
 * Compile-level test: verifies that TransitionResult* interfaces use only domain shapes
 * and that @prisma/client is NOT needed to type transition results.
 *
 * If this file compiles successfully (tsc --noEmit), Task 8 constraints are met.
 */
import type {
  TransitionTicketShape,
  TransitionCommentShape,
  TransitionActivityShape,
  TransitionResultWithComment,
  TransitionResultWithoutComment,
  TransitionResult,
} from './ticket-transitions.service';

describe('TransitionResult domain shapes (compile-level)', () => {
  it('TransitionResultWithComment can be constructed without Prisma types', () => {
    const ticket: TransitionTicketShape = {
      id: 'ticket-1',
      status: 'VERIFIED',
      title: 'Fix the bug',
      projectId: 'proj-1',
      number: 42,
    };

    const comment: TransitionCommentShape = {
      id: 'comment-1',
      ticketId: 'ticket-1',
      body: 'Looks good',
      type: 'VERIFICATION',
    };

    const activity: TransitionActivityShape = {
      id: 'activity-1',
      ticketId: 'ticket-1',
      action: 'STATUS_CHANGE',
    };

    const result: TransitionResultWithComment = { ticket, comment, activity };

    expect(result.ticket.id).toBe('ticket-1');
    expect(result.comment.body).toBe('Looks good');
    expect(result.activity.action).toBe('STATUS_CHANGE');
  });

  it('TransitionResultWithoutComment can be constructed without Prisma types', () => {
    const ticket: TransitionTicketShape = {
      id: 'ticket-2',
      status: 'IN_PROGRESS',
      title: 'Another task',
      projectId: 'proj-1',
      number: 7,
    };

    const activity: TransitionActivityShape = {
      id: 'activity-2',
      ticketId: 'ticket-2',
      action: 'STATUS_CHANGE',
    };

    const result: TransitionResultWithoutComment = { ticket, activity };

    expect(result.ticket.number).toBe(7);
    expect(result.activity.id).toBe('activity-2');
  });

  it('TransitionResult union type accepts both result shapes', () => {
    const withComment: TransitionResult = {
      ticket: { id: 't1', status: 'CLOSED', title: 'T', projectId: 'p1', number: 1 },
      comment: { id: 'c1', ticketId: 't1', body: 'done', type: 'REVIEW' },
      activity: { id: 'a1', ticketId: 't1', action: 'STATUS_CHANGE' },
    };

    const withoutComment: TransitionResult = {
      ticket: { id: 't2', status: 'IN_PROGRESS', title: 'T2', projectId: 'p1', number: 2 },
      activity: { id: 'a2', ticketId: 't2', action: 'STATUS_CHANGE' },
    };

    expect(withComment).toBeDefined();
    expect(withoutComment).toBeDefined();
  });
});
