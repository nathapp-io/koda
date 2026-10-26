import { Prisma, PrismaClient } from '../generated/prisma/client';
import { withTransactionTally } from '../action-context/audit-coverage';
import { contextlessWriteHandler, resolveWriteGuardMode, type WriteGuardMode } from '../action-context/contextless-write';

/** The top-level `$allOperations` hook also receives raw operations, with `model` undefined. */
export function contextlessWriteExtension(mode: WriteGuardMode) {
  return Prisma.defineExtension({
    name: 'contextless-write-guard',
    query: { $allOperations: contextlessWriteHandler(mode) },
  });
}

/**
 * Permissions P2 US-002: the API's Prisma client — the generated client with the context-less write
 * guard (design §5). A model write or raw execute with no action context throws in development and
 * test, and is recorded as `SYSTEM/unknown` in production.
 */
export class KodaPrismaClient extends PrismaClient {
  constructor(options: Prisma.PrismaClientOptions) {
    super(options);
    // PrismaService does `new options.client(options.clientOptions)`, so the extended client returned
    // here is the one every repository, the transaction manager and every interactive transaction use.
    // Prisma propagates `$extends` into the `tx` of an interactive transaction, so a guarded write
    // there rejects before the statement runs and the transaction rolls back.
    // The returned object is not `instanceof KodaPrismaClient`; nothing in the API checks that.
    const extended = this.$extends(
      contextlessWriteExtension(
        resolveWriteGuardMode({ ENV_NAME: process.env['ENV_NAME'], NODE_ENV: process.env['NODE_ENV'] }),
      ),
    );
    return new Proxy(extended, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property);

        return (
          input: ((tx: Prisma.TransactionClient) => Promise<unknown>) | readonly Prisma.PrismaPromise<unknown>[],
          options?: unknown,
        ) => {
          const transaction: (input: unknown, options?: unknown) => unknown = Reflect.get(target, '$transaction');
          if (typeof input === 'function') {
            return transaction.call(target, (tx: Prisma.TransactionClient) => withTransactionTally(() => input(tx)), options);
          }
          return transaction.call(target, input, options);
        };
      },
    }) as unknown as KodaPrismaClient;
  }
}
