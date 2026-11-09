import { describe, expect, it } from 'vitest';
import { groupFindingsByFeature, nextFlowFeature, type FlowFeatureView } from './flow-features';

const feature = (id: string, position: number, state: string, dependsOn: string[] = []): FlowFeatureView => ({
  id, position, feature: `feature-${id}`, dependsOn, state, prNumber: null,
});

describe('nextFlowFeature', () => {
  it('AC-1 keeps the first pending feature active before the flow starts', () => {
    expect(nextFlowFeature([feature('one', 0, 'PENDING'), feature('two', 1, 'PENDING')])).toEqual({ kind: 'active', featureId: 'one' });
  });
  it('AC-2 selects a running later feature', () => {
    expect(nextFlowFeature([feature('one', 0, 'READY'), feature('two', 1, 'RUNNING')])).toEqual({ kind: 'active', featureId: 'two' });
  });
  it('AC-3 selects a feature waiting for an answer', () => {
    expect(nextFlowFeature([feature('one', 0, 'READY'), feature('two', 1, 'WAITING_ANSWER')])).toEqual({ kind: 'active', featureId: 'two' });
  });
  it('AC-4 starts an independent pending feature from spec', () => {
    expect(nextFlowFeature([feature('one', 0, 'READY'), feature('two', 1, 'PENDING')])).toEqual({ kind: 'start', featureId: 'two', base: 'spec' });
  });
  it('AC-5 starts a dependent feature from default when dependencies merged', () => {
    expect(nextFlowFeature([feature('one', 0, 'MERGED'), feature('two', 1, 'PENDING', ['feature-one'])])).toEqual({ kind: 'start', featureId: 'two', base: 'default' });
  });
  it('AC-6 waits for unmerged dependencies', () => {
    expect(nextFlowFeature([feature('one', 0, 'READY'), feature('two', 1, 'PENDING', ['feature-one'])])).toEqual({ kind: 'wait_merge', featureIds: ['one'] });
  });
  it('AC-7 waits only for dependencies that are not merged', () => {
    expect(nextFlowFeature([feature('one', 0, 'MERGED'), feature('two', 1, 'READY'), feature('three', 2, 'PENDING', ['feature-one', 'feature-two'])])).toEqual({ kind: 'wait_merge', featureIds: ['two'] });
  });
  it('AC-8 completes when no feature is pending or active', () => {
    expect(nextFlowFeature([feature('one', 0, 'READY'), feature('two', 1, 'MERGED')])).toEqual({ kind: 'complete' });
  });
  it('AC-9 orders by position without mutating input', () => {
    const input = [feature('two', 1, 'PENDING'), feature('one', 0, 'PENDING')];
    expect(nextFlowFeature(input)).toEqual({ kind: 'active', featureId: 'one' });
    expect(input.map(({ id }) => id)).toEqual(['two', 'one']);
  });
});

describe('groupFindingsByFeature', () => {
  const features = [feature('two', 1, 'PENDING'), feature('one', 0, 'PENDING'), feature('three', 2, 'PENDING')];
  it('AC-10 groups in position order, retains finding order, and omits empty groups', () => {
    const findings = [
      { class: 'minor' as const, summary: 'first', feature: 'feature-two' },
      { class: 'minor' as const, summary: 'second', feature: 'feature-one' },
      { class: 'minor' as const, summary: 'third', feature: 'feature-two' },
    ];
    expect(groupFindingsByFeature(findings, features)).toEqual([
      { feature: features[1], findings: [findings[1]] },
      { feature: features[0], findings: [findings[0], findings[2]] },
    ]);
  });
  it('AC-11 sends missing and unknown feature names to the first feature', () => {
    const findings = [
      { class: 'minor' as const, summary: 'missing' },
      { class: 'minor' as const, summary: 'unknown', feature: 'absent' },
      { class: 'minor' as const, summary: 'known', feature: 'feature-two' },
    ];
    expect(groupFindingsByFeature(findings, features)).toEqual([
      { feature: features[1], findings: findings.slice(0, 2) },
      { feature: features[0], findings: [findings[2]] },
    ]);
  });
  it('returns no groups for no features', () => {
    expect(groupFindingsByFeature([{ class: 'minor', summary: 'x' }], [])).toEqual([]);
  });
});
