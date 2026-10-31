import { prNumberOfReviewFeature, reviewFeature } from './review-jobs';

describe('review job features', () => {
  it('AC-1: creates canonical review feature names', () => expect(reviewFeature(42)).toBe('review-pr-42'));
  it('AC-2: parses canonical PR numbers', () => expect(prNumberOfReviewFeature('review-pr-42')).toBe(42));
  it.each(['review-pr-042', 'review-pr-99999999999999999999', 'login'])('AC-3/4/5: rejects %s', (feature) => {
    expect(prNumberOfReviewFeature(feature)).toBeNull();
  });
});
