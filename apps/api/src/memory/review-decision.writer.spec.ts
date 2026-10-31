import { reviewDecisionObject } from './review-decision.writer';
import { PERMISSION_CATALOG } from '../permissions/catalog';

const text = { finding: 'missing null check', reason: 'guarded upstream' };
describe('reviewDecisionObject', () => {
  it('AC-1: includes file and line', () => {
    expect(reviewDecisionObject({ ...text, file: 'src/a.ts', line: 12 })).toBe('Not a defect: missing null check. Reason: guarded upstream (src/a.ts:12)');
  });
  it('AC-2: includes a file without a line', () => {
    expect(reviewDecisionObject({ ...text, file: 'src/a.ts' })).toBe('Not a defect: missing null check. Reason: guarded upstream (src/a.ts)');
  });
  it('AC-3: omits absent location', () => {
    expect(reviewDecisionObject(text)).toBe('Not a defect: missing null check. Reason: guarded upstream');
    expect(reviewDecisionObject({ ...text, line: 12 })).toBe(reviewDecisionObject(text));
  });
  it('AC-12: declares the system key', () => {
    expect(PERMISSION_CATALOG.find(({ key }) => key === 'system.review.decision')).toMatchObject({ access: 'system', scope: 'any' });
  });
});
