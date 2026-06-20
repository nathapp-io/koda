import { ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaLabelRepository } from './prisma-label.repository';
import { Prisma } from '@prisma/client';

describe('PrismaLabelRepository', () => {
  describe('createLabel', () => {
    it('throws ValidationAppException on P2002 unique-constraint violation', async () => {
      const createMock = jest.fn().mockRejectedValue(
        Object.assign(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '0' }), {})
      );

      const prisma = {
        client: {
          label: {
            create: createMock,
          },
        },
      } as any;

      const txManager = {
        run: (fn: () => Promise<unknown>) => fn(),
        getClient: () => ({}),
        isInTransaction: () => false,
      } as any;

      const repo = new PrismaLabelRepository(txManager, prisma);
      await expect(repo.createLabel({ projectId: 'p1', name: 'dup', color: null }))
        .rejects.toBeInstanceOf(ValidationAppException);
    });
  });
});
