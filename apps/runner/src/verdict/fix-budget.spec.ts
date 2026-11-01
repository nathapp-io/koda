import { describe, expect, test } from 'bun:test';
import { fixBudgetRemainder } from './fix-budget';

describe('fixBudgetRemainder', () => {
  test('AC-6: subtracts decimal spend exactly', () => {
    expect(fixBudgetRemainder('1', '0.3000')).toBe(0.7);
  });
  test('AC-7: subtracts smaller decimal spend exactly', () => {
    expect(fixBudgetRemainder('1', '0.0700')).toBe(0.93);
  });
  test('AC-8: returns null when the budget is exhausted', () => {
    expect(fixBudgetRemainder('0.05', '0.0500')).toBeNull();
  });
  test('AC-9: returns null when the spend ledger is unreadable', () => {
    expect(fixBudgetRemainder('1', undefined)).toBeNull();
  });
  test('does not use floating point for deciding whether any budget remains', () => {
    expect(fixBudgetRemainder('0.3', '0.3001')).toBeNull();
    expect(fixBudgetRemainder('1.0001', '1')).toBeCloseTo(0.0001);
  });
});
