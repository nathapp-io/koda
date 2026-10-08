import { BudgetScopeLabels } from './budget-scope-labels';

describe('BudgetScopeLabels (S4a §2.4)', () => {
  const db = {
    project: { findUnique: jest.fn(async () => ({ key: 'KODA' })) },
    fleetRepo: { findUnique: jest.fn(async () => ({ owner: 'acme', name: 'app' })) },
    runner: { findUnique: jest.fn(async () => ({ name: 'wk-mac' })) },
    budgetPolicy: { findUnique: jest.fn(async () => ({ scopeType: 'runner', scopeId: 'rn1' })) },
  };
  const labels = new BudgetScopeLabels({ client: db } as never);
  afterEach(() => jest.clearAllMocks());

  it.each([
    [{ scopeType: 'global', scopeId: null }, 'global'],
    [{ scopeType: 'project', scopeId: 'p1' }, 'project KODA'],
    [{ scopeType: 'repo', scopeId: 'r1' }, 'acme/app'],
    [{ scopeType: 'runner', scopeId: 'rn1' }, 'runner wk-mac'],
  ] as const)('labels %j as %s', async (scope, expected) => {
    expect(await labels.forScope(scope)).toBe(expected);
  });

  it('labels a scope whose row is gone by type and id', async () => {
    db.fleetRepo.findUnique.mockResolvedValueOnce(null);
    expect(await labels.forScope({ scopeType: 'repo', scopeId: 'r9' })).toBe('repo r9');
  });

  it('labels a policy by its scope; null when the policy is gone', async () => {
    expect(await labels.forPolicy('pol1')).toBe('runner wk-mac');
    db.budgetPolicy.findUnique.mockResolvedValueOnce(null);
    expect(await labels.forPolicy('gone')).toBeNull();
  });
});
