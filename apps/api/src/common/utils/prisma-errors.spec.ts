import { Prisma } from '@prisma/client';
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
});
