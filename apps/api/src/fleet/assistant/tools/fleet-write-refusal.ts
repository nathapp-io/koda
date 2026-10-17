import { AppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';

function argument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Turns known fleet write refusals into a concise reason for the assistant. */
export function fleetWriteRefusal(error: unknown): string | null {
  if (!(error instanceof AppException)) return null;

  const args = error.args;
  if (error instanceof ConflictAppException) {
    switch (error.prefix) {
      case 'fleet.jobState': {
        const state = argument(args, 'state');
        return state === null ? null : `job is ${state}`;
      }
      case 'fleet.jobs': {
        const activeJobId = argument(args, 'activeJobId');
        return activeJobId === null ? null : `job ${activeJobId} is already active for this feature`;
      }
      case 'fleet.dispatchOpenPr': {
        const refs = argument(args, 'refs');
        return refs === null ? null : `open PR on ${refs}`;
      }
      case 'fleet.budgetPaused': {
        const scope = argument(args, 'scope');
        return scope === null ? null : `budget paused for ${scope}`;
      }
      case 'fleet.configRequeue': {
        const outcome = argument(args, 'outcome');
        return outcome === null ? null : `the config edit ended ${outcome}`;
      }
      default:
        return null;
    }
  }

  if (error instanceof ValidationAppException && error.prefix === 'fleet.dispatchInput') {
    const reason = argument(args, 'reason');
    return reason === null ? null : `invalid ${reason}`;
  }

  return null;
}
