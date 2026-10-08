import { Prisma } from '../../generated/prisma/client';
import { isUniqueViolation } from './prisma-errors';

function p2002(target: unknown) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: 'test', meta: { target },
  });
}

describe('isUniqueViolation', () => {
  it('matches P2002 on the named field (array or string target)', () => {
    expect(isUniqueViolation(p2002(['email']), 'email')).toBe(true);
    expect(isUniqueViolation(p2002('User_email_key'), 'email')).toBe(true);
  });

  it('ignores other fields, other codes and non-Prisma errors', () => {
    expect(isUniqueViolation(p2002(['number']), 'email')).toBe(false);
    expect(isUniqueViolation(new Error('boom'), 'email')).toBe(false);
    expect(isUniqueViolation(
      new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }), 'email',
    )).toBe(false);
  });

  describe('driver-adapter shape (Prisma 7: no meta.target)', () => {
    const adapterError = (constraint: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: {
          modelName: 'User',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: { kind: 'UniqueConstraintViolation', originalCode: '23505', constraint },
          },
        },
      });

    it('matches the field inside the violated index name', () => {
      expect(isUniqueViolation(adapterError({ index: 'User_email_key' }), 'email')).toBe(true);
    });

    it('matches a column of a compound index name', () => {
      expect(isUniqueViolation(adapterError({ index: 'ProjectMember_projectId_userId_key' }), 'userId')).toBe(true);
      expect(isUniqueViolation(adapterError({ index: 'Ticket_projectId_number_key' }), 'number')).toBe(true);
    });

    it('matches a fields array', () => {
      expect(isUniqueViolation(adapterError({ fields: ['slug'] }), 'slug')).toBe(true);
    });

    it('does not match an index on another column', () => {
      expect(isUniqueViolation(adapterError({ index: 'Agent_slug_key' }), 'email')).toBe(false);
    });

    it('is false when the adapter names no constraint', () => {
      expect(isUniqueViolation(adapterError({}), 'email')).toBe(false);
    });
  });
});
