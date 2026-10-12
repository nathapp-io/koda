import { Prisma } from '../../../generated/prisma/client';
import { round4 } from './thread-cost';

describe('round4 (US-005)', () => {
  it('US-005: rounds decimal money half-up to four places without floating point', () => {
    expect(round4(new Prisma.Decimal('0.00005')).toString()).toBe('0.0001');
    expect(round4(new Prisma.Decimal('0.00004').mul(10)).toString()).toBe('0.0004');
    expect(round4(new Prisma.Decimal('0')).toString()).toBe('0');
  });
});
