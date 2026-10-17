import { ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../../budgets/budget.exceptions';
import { fleetWriteRefusal } from './fleet-write-refusal';

describe('fleetWriteRefusal', () => {
  it('AC-1: explains a fleet.jobState conflict', () => {
    expect(fleetWriteRefusal(new ConflictAppException({ state: 'RUNNING' }, 'fleet.jobState'))).toBe('job is RUNNING');
  });

  it('AC-2: explains an already-active feature conflict', () => {
    expect(fleetWriteRefusal(new ConflictAppException({ activeJobId: 'j9' }, 'fleet.jobs'))).toBe(
      'job j9 is already active for this feature',
    );
  });

  it('AC-3: explains dispatch blocked by an open PR', () => {
    expect(fleetWriteRefusal(new ConflictAppException({ refs: 'WEB-1, WEB-2' }, 'fleet.dispatchOpenPr'))).toBe(
      'open PR on WEB-1, WEB-2',
    );
  });

  it('AC-4: explains a paused budget scope', () => {
    const policy = { id: 'bp1', scopeType: 'project' as const, scopeId: 'p1', scopeKey: 'project:p1' };
    expect(fleetWriteRefusal(new BudgetPausedException(policy))).toBe('budget paused for project:p1');
  });

  it('AC-5: explains an unrecoverable config edit outcome', () => {
    expect(fleetWriteRefusal(new ConflictAppException({ outcome: 'conflict' }, 'fleet.configRequeue'))).toBe(
      'the config edit ended conflict',
    );
  });

  it('AC-6: explains invalid dispatch input', () => {
    expect(fleetWriteRefusal(new ValidationAppException({ reason: 'ticket WEB-9' }, 'fleet.dispatchInput'))).toBe(
      'invalid ticket WEB-9',
    );
  });

  it('AC-7: leaves unrelated AppExceptions unexplained', () => {
    expect(fleetWriteRefusal(new ConflictAppException({}, 'threads.busy'))).toBeNull();
  });

  it('AC-8: leaves ordinary errors unexplained', () => {
    expect(fleetWriteRefusal(new Error('boom'))).toBeNull();
  });
});
