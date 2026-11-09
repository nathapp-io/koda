import { countUnknownCost, totalCostUsd, UNKNOWN_COST_COMMANDS } from './flow-overview';
import type { FlowJobRow } from './domain/fleet-flow-step.domain';

function row(values: Partial<FlowJobRow> = {}): FlowJobRow {
  return { id: 'j', flowFeatureId: null, flowStep: null, command: 'RUN', state: 'RUNNING', costSpentUsd: '0.0000', costCarriedUsd: '0.0000', queuedAt: new Date(0), finishedAt: null, ...values };
}

describe('flow overview helpers', () => {
  it('adds decimal costs exactly and formats four places', () => {
    expect(totalCostUsd(row({ costSpentUsd: '0.1100', costCarriedUsd: '0.0020' }))).toBe('0.1120');
  });
  it('counts zero-cost supported terminal jobs only', () => {
    expect(UNKNOWN_COST_COMMANDS).toEqual(['AGENT', 'PLAN', 'REVIEW', 'FIX']);
    expect(countUnknownCost([
      row({ command: 'AGENT', state: 'COMPLETED' }), row({ command: 'PLAN', state: 'FAILED' }),
      row({ command: 'RUN', state: 'CANCELLED' }), row({ command: 'REVIEW', state: 'RUNNING' }),
      row({ command: 'FIX', state: 'COMPLETED', costSpentUsd: '0.0500' }),
    ])).toBe(2);
  });
});
