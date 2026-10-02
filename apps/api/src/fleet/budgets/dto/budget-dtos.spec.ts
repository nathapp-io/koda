import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBudgetPolicyDto } from './create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './update-budget-policy.dto';

const errors = (cls: new () => object, body: object): string[] =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);

describe('budget DTOs (S1b §2.1, §2.4)', () => {
  const create = { scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 50 };

  it('accepts a minimal create, an explicit null warnPercent, and the full option set', () => {
    expect(errors(CreateBudgetPolicyDto, create)).toEqual([]);
    expect(errors(CreateBudgetPolicyDto, { ...create, warnPercent: null })).toEqual([]);
    expect(errors(CreateBudgetPolicyDto, { ...create, scopeType: 'runner', scopeId: 'r1', warnPercent: 90, hardStop: false, runningJobs: 'cancel' })).toEqual([]);
  });

  it.each([
    ['scopeType', { scopeType: 'team' }],
    ['windowKind', { windowKind: 'week' }],
    ['amountUsd', { amountUsd: 0 }],
    ['amountUsd', { amountUsd: 1.00001 }],
    ['amountUsd', { amountUsd: 1_000_001 }],
    ['warnPercent', { warnPercent: 0 }],
    ['warnPercent', { warnPercent: 100 }],
    ['warnPercent', { warnPercent: 50.5 }],
    ['runningJobs', { runningJobs: 'kill' }],
  ])('rejects a bad %s on create', (property, over) => {
    expect(errors(CreateBudgetPolicyDto, { ...create, ...over })).toContain(property);
  });

  it('treats an omitted update field as unchanged and rejects an explicit null amount', () => {
    expect(errors(UpdateBudgetPolicyDto, {})).toEqual([]);
    expect(errors(UpdateBudgetPolicyDto, { warnPercent: null })).toEqual([]);
    expect(errors(UpdateBudgetPolicyDto, { amountUsd: null })).toContain('amountUsd');
    expect(errors(ResumeBudgetPolicyDto, {})).toEqual([]);
    expect(errors(ResumeBudgetPolicyDto, { amountUsd: -1 })).toContain('amountUsd');
  });
});
