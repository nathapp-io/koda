import { BadRequestException } from '@nestjs/common';
import { TicketStatus, CommentType } from '@prisma/client';
import { validateTransition } from './ticket-transitions';

describe('validateTransition', () => {
  describe('Valid Transitions', () => {
    it('allows CREATED → VERIFIED with VERIFICATION comment', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.VERIFICATION)
      ).not.toThrow();
    });

    it('allows CREATED → REJECTED with GENERAL comment', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.REJECTED, CommentType.GENERAL)
      ).not.toThrow();
    });

    it('allows VERIFIED → IN_PROGRESS without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS)
      ).not.toThrow();
    });

    it('allows VERIFIED → REJECTED with GENERAL comment', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFIED, TicketStatus.REJECTED, CommentType.GENERAL)
      ).not.toThrow();
    });

    it('allows IN_PROGRESS → VERIFY_FIX with FIX_REPORT comment', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT)
      ).not.toThrow();
    });

    it('allows IN_PROGRESS → VERIFIED with GENERAL comment (sent back)', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, CommentType.GENERAL)
      ).not.toThrow();
    });

    it('allows VERIFY_FIX → CLOSED with REVIEW comment', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.CLOSED, CommentType.REVIEW)
      ).not.toThrow();
    });

    it('allows VERIFY_FIX → IN_PROGRESS with REVIEW comment (fix failed)', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS, CommentType.REVIEW)
      ).not.toThrow();
    });
  });

  describe('Invalid Transitions', () => {
    it('throws BadRequestException for CREATED → IN_PROGRESS', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.IN_PROGRESS)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for CREATED → VERIFY_FIX', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFY_FIX)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for CREATED → CLOSED', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.CLOSED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for VERIFIED → VERIFIED', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFIED, TicketStatus.VERIFIED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for VERIFIED → VERIFY_FIX', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFIED, TicketStatus.VERIFY_FIX)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for IN_PROGRESS → REJECTED', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.REJECTED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for IN_PROGRESS → CLOSED', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.CLOSED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for IN_PROGRESS → CREATED', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.CREATED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for VERIFY_FIX → VERIFIED', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.VERIFIED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for VERIFY_FIX → REJECTED', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.REJECTED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for CLOSED → any status', () => {
      expect(() =>
        validateTransition(TicketStatus.CLOSED, TicketStatus.CREATED)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.CLOSED, TicketStatus.IN_PROGRESS)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.CLOSED, TicketStatus.VERIFIED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for REJECTED → any status', () => {
      expect(() =>
        validateTransition(TicketStatus.REJECTED, TicketStatus.CREATED)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.REJECTED, TicketStatus.IN_PROGRESS)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.REJECTED, TicketStatus.VERIFIED)
      ).toThrow(BadRequestException);
    });
  });

  describe('Missing Required Comment Types', () => {
    it('throws BadRequestException when CREATED → VERIFIED without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when CREATED → VERIFIED with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.GENERAL)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.FIX_REPORT)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when CREATED → REJECTED without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.REJECTED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when CREATED → REJECTED with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.REJECTED, CommentType.VERIFICATION)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when VERIFIED → REJECTED without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFIED, TicketStatus.REJECTED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when VERIFIED → REJECTED with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFIED, TicketStatus.REJECTED, CommentType.VERIFICATION)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when IN_PROGRESS → VERIFY_FIX without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when IN_PROGRESS → VERIFY_FIX with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX, CommentType.REVIEW)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX, CommentType.GENERAL)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when IN_PROGRESS → VERIFIED without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when IN_PROGRESS → VERIFIED with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, CommentType.FIX_REPORT)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when VERIFY_FIX → CLOSED without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.CLOSED)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when VERIFY_FIX → CLOSED with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.CLOSED, CommentType.GENERAL)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.CLOSED, CommentType.FIX_REPORT)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when VERIFY_FIX → IN_PROGRESS without comment', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS)
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when VERIFY_FIX → IN_PROGRESS with wrong comment type', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS, CommentType.GENERAL)
      ).toThrow(BadRequestException);

      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS, CommentType.FIX_REPORT)
      ).toThrow(BadRequestException);
    });
  });

  describe('Correct Comment Type Handling', () => {
    it('accepts VERIFICATION comment for CREATED → VERIFIED', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.VERIFICATION)
      ).not.toThrow();
    });

    it('accepts only VERIFICATION (not GENERAL) for CREATED → VERIFIED', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.GENERAL)
      ).toThrow();
    });

    it('accepts GENERAL comment for CREATED → REJECTED', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.REJECTED, CommentType.GENERAL)
      ).not.toThrow();
    });

    it('accepts only GENERAL for CREATED → REJECTED (not VERIFICATION)', () => {
      expect(() =>
        validateTransition(TicketStatus.CREATED, TicketStatus.REJECTED, CommentType.VERIFICATION)
      ).toThrow();
    });

    it('accepts FIX_REPORT for IN_PROGRESS → VERIFY_FIX', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT)
      ).not.toThrow();
    });

    it('accepts GENERAL for IN_PROGRESS → VERIFIED', () => {
      expect(() =>
        validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, CommentType.GENERAL)
      ).not.toThrow();
    });

    it('accepts REVIEW for VERIFY_FIX → CLOSED', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.CLOSED, CommentType.REVIEW)
      ).not.toThrow();
    });

    it('accepts REVIEW for VERIFY_FIX → IN_PROGRESS', () => {
      expect(() =>
        validateTransition(TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS, CommentType.REVIEW)
      ).not.toThrow();
    });
  });

  describe('Error Messages', () => {
    it('provides clear error message for invalid transition', () => {
      try {
        validateTransition(TicketStatus.CREATED, TicketStatus.CLOSED);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const err = error as BadRequestException;
        expect(err.message).toContain('CREATED');
        expect(err.message).toContain('CLOSED');
      }
    });

    it('provides clear error message when comment type is required but missing', () => {
      try {
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const err = error as BadRequestException;
        expect(err.message).toContain('VERIFICATION');
      }
    });

    it('provides clear error message when comment type is wrong', () => {
      try {
        validateTransition(TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.GENERAL);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const err = error as BadRequestException;
        expect(err.message).toContain('GENERAL');
        expect(err.message).toContain('VERIFICATION');
      }
    });
  });
});
