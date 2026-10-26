import { Logger } from '@nestjs/common';
import { currentContext, runAsSystem } from './action-context';
import { noteAuditWrite } from './audit-coverage';

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

function changedRows(operation: string, result: unknown): boolean {
  if (operation === 'create' || operation === 'update' || operation === 'upsert' || operation === 'delete') {
    return true;
  }

  if (operation === 'createManyAndReturn' || operation === 'updateManyAndReturn') {
    return Array.isArray(result) && result.length > 0;
  }

  if (operation === '$executeRaw' || operation === '$executeRawUnsafe') {
    return typeof result === 'number' && result > 0;
  }

  if (operation === 'createMany' || operation === 'updateMany' || operation === 'deleteMany') {
    return typeof result === 'object' && result !== null &&
      'count' in result && typeof result.count === 'number' && result.count > 0;
  }

  return false;
}

export function contextlessWriteHandler(mode: WriteGuardMode): (params: GuardedOperationParams) => Promise<unknown> {
  const logger = new Logger(ContextlessWriteError.name);

  return async ({ model, operation, args, query }) => {
    const inActionContext = currentContext() !== undefined;
    if (!GUARDED_OPERATIONS.has(operation)) {
      return await query(args);
    }

    if (inActionContext) {
      const result = await query(args);
      if (model !== 'AuditEntry' && changedRows(operation, result)) {
        noteAuditWrite(model === undefined ? operation : `${model}.${operation}`);
      }
      return result;
    }

    if (mode === 'throw') {
      throw new ContextlessWriteError(operation, model);
    }

    logger.error(`write outside an action context: ${model === undefined ? operation : `${model}.${operation}`}`);
    return await runAsSystem('unknown', async () => await query(args));
  };
}
