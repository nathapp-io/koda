export const REVIEW_FEATURE_PREFIX = 'review-pr-';

export function reviewFeature(prNumber: number): string {
  return `${REVIEW_FEATURE_PREFIX}${prNumber}`;
}

export function prNumberOfReviewFeature(feature: string): number | null {
  const match = /^review-pr-([1-9]\d*)$/.exec(feature);
  if (!match) return null;
  const prNumber = Number(match[1]);
  return Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null;
}
