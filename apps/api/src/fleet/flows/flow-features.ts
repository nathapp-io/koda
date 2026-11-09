import type { FlowFinding } from './flow-verdict';

export interface FlowFeatureView {
  id: string;
  position: number;
  feature: string;
  dependsOn: string[];
  state: string;
  prNumber: number | null;
}

export type FlowFeatureAction =
  | { kind: 'active'; featureId: string }
  | { kind: 'start'; featureId: string; base: 'spec' | 'default' }
  | { kind: 'wait_merge'; featureIds: string[] }
  | { kind: 'complete' };

export function nextFlowFeature(features: readonly FlowFeatureView[]): FlowFeatureAction {
  const ordered = [...features].sort((left, right) => left.position - right.position);
  const active = ordered.find(({ state }) => state === 'RUNNING' || state === 'WAITING_ANSWER');
  if (active) return { kind: 'active', featureId: active.id };

  const first = ordered[0];
  if (first?.state === 'PENDING') return { kind: 'active', featureId: first.id };

  const pending = ordered.find(({ state }) => state === 'PENDING');
  if (!pending) return { kind: 'complete' };

  const waitingFor = pending.dependsOn
    .map((dependency) => ordered.find(({ feature }) => feature === dependency))
    .filter((dependency) => dependency !== undefined && dependency.state !== 'MERGED');
  if (waitingFor.length === 0) {
    return { kind: 'start', featureId: pending.id, base: pending.dependsOn.length > 0 ? 'default' : 'spec' };
  }
  return { kind: 'wait_merge', featureIds: waitingFor.map(({ id }) => id) };
}

export type FlowFindingForFeature = FlowFinding & { feature?: string };
export interface FlowFindingGroup {
  feature: FlowFeatureView;
  findings: FlowFindingForFeature[];
}

export function groupFindingsByFeature(
  findings: readonly FlowFindingForFeature[],
  features: readonly FlowFeatureView[],
): FlowFindingGroup[] {
  const ordered = [...features].sort((left, right) => left.position - right.position);
  const groups = new Map<string, FlowFindingForFeature[]>();
  for (const finding of findings) {
    const target = ordered.find(({ feature }) => feature === finding.feature) ?? ordered[0];
    if (!target) continue;
    const group = groups.get(target.id) ?? [];
    group.push(finding);
    groups.set(target.id, group);
  }
  return ordered.flatMap((feature) => {
    const groupedFindings = groups.get(feature.id);
    return groupedFindings ? [{ feature, findings: groupedFindings }] : [];
  });
}
