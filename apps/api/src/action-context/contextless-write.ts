import { Logger } from '@nestjs/common';
import { currentContext, runAsSystem } from './action-context';

export type WriteGuardMode = 'throw' | 'record';

export const GUARDED_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  '$executeRaw',
  '$executeRawUnsafe',
]);

export class ContextlessWriteError extends Error {
  readonly name = 'ContextlessWriteError';

  constructor(readonly operation: string, readonly model?: string) {
    super(`write outside an action context: ${model === undefined ? operation : `${model}.${operation}`}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function resolveWriteGuardMode(env: { ENV_NAME?: string; NODE_ENV?: string }): WriteGuardMode {
  return env.ENV_NAME === 'production' || env.NODE_ENV === 'production' ? 'record' : 'throw';
}

export interface GuardedOperationParams {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => PromiseLike<unknown>;
}

export function contextlessWriteHandler(mode: WriteGuardMode): (params: GuardedOperationParams) => Promise<unknown> {
  const logger = new Logger(ContextlessWriteError.name);

  return async ({ model, operation, args, query }) => {
    if (!GUARDED_OPERATIONS.has(operation) || currentContext() !== undefined) {
      return await query(args);
    }

    if (mode === 'throw') {
      throw new ContextlessWriteError(operation, model);
    }

    logger.error(`write outside an action context: ${model === undefined ? operation : `${model}.${operation}`}`);
    return await runAsSystem('unknown', async () => await query(args));
  };
}
