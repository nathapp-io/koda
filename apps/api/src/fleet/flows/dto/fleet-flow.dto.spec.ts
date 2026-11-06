import { describe, expect, it } from 'vitest';
import type { FleetFlowRecord } from '../domain/fleet-flow.domain';
import { FleetFlowDto } from './fleet-flow.dto';

const CREATED_AT = new Date('2026-11-05T10:00:00.000Z');
const APPROVED_AT = new Date('2026-11-05T11:00:00.000Z');

const record = (overrides: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1',
  projectId: 'project-1',
  repoId: 'repo-1',
  threadId: 'thread-1',
  entry: 'THREAD',
  createdByType: 'USER',
  createdById: 'user-1',
  branch: 'feat/flow-a',
  specSha: 'a'.repeat(40),
  pinnedRunnerId: 'runner-1',
  reviewerRole: 'acp:claude',
  supervisorRole: 'native:fast',
  costCapUsd: '25.0000',
  spentUsd: '0.0000',
  state: 'PENDING',
  approvalMode: null,
  approverId: null,
  approvedAt: null,
  approvalRequestId: null,
  stopReason: null,
  endedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  features: [
    {
      id: 'feature-2', flowId: 'flow-1', position: 1, feature: 'flow-b', specPath: '.nax/features/flow-b/spec.md',
      dependsOn: ['flow-a'], state: 'PENDING', currentStep: null, prNumber: null,
    },
    {
      id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md',
      dependsOn: [], state: 'RUNNING', currentStep: 'spec-review', prNumber: 12,
    },
  ],
  ...overrides,
});

describe('FleetFlowDto', () => {
  it('maps the record to the response contract, features in position order', () => {
    expect(FleetFlowDto.from(record(), 'web')).toEqual({
      id: 'flow-1',
      projectId: 'project-1',
      repoId: 'repo-1',
      threadId: 'thread-1',
      entry: 'THREAD',
      createdBy: { type: 'USER', id: 'user-1' },
      branch: 'feat/flow-a',
      specSha: 'a'.repeat(40),
      pinnedRunnerId: 'runner-1',
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' },
      costCapUsd: '25.0000',
      spentUsd: '0.0000',
      state: 'PENDING',
      approval: null,
      stopReason: null,
      endedAt: null,
      createdAt: CREATED_AT.toISOString(),
      features: [
        { feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md', dependsOn: [], state: 'RUNNING', currentStep: 'spec-review', prNumber: 12 },
        { feature: 'flow-b', specPath: '.nax/features/flow-b/spec.md', dependsOn: ['flow-a'], state: 'PENDING', currentStep: null, prNumber: null },
      ],
      url: '/web/flows/flow-1',
    });
  });

  it('answers the approval block when the flow is approved, and the end fields of a stopped flow', () => {
    const dto = FleetFlowDto.from(record({
      state: 'STOPPED', approvalMode: 'PRE_APPROVED', approverId: 'user-2', approvedAt: APPROVED_AT,
      stopReason: 'manual', endedAt: APPROVED_AT,
    }), 'web');

    expect(dto.approval).toEqual({
      mode: 'PRE_APPROVED', approverId: 'user-2', approvedAt: APPROVED_AT.toISOString(), approvalRequestId: null,
    });
    expect(dto).toMatchObject({ stopReason: 'manual', endedAt: APPROVED_AT.toISOString() });
  });

  /**
   * The row `FleetFlowsService.create` leaves behind when no tick covers the flow: PENDING, no approval
   * mode (nothing has been decided yet), and the `fleet.flow.start` request it waits on. The request is
   * part of the record the client shows, so the approval block must be answered for it — as REQUEST,
   * the mode a decision on that request will persist.
   */
  it('answers the approval block of the request a freshly created PENDING flow waits on', () => {
    const dto = FleetFlowDto.from(record({ state: 'PENDING', approvalMode: null, approvalRequestId: 'request-1' }), 'web');

    expect(dto.approval).toEqual({
      mode: 'REQUEST', approverId: null, approvedAt: null, approvalRequestId: 'request-1',
    });
  });

  it('keeps the nax entry free of a thread and carries the request of a flow approved through it', () => {
    const dto = FleetFlowDto.from(record({
      entry: 'NAX', threadId: null, pinnedRunnerId: null, createdByType: 'AGENT', createdById: 'agent-1',
      state: 'APPROVED', approvalMode: 'REQUEST', approverId: 'user-2', approvedAt: APPROVED_AT,
      approvalRequestId: 'request-1',
    }), 'web');

    expect(dto).toMatchObject({
      entry: 'NAX', threadId: null, pinnedRunnerId: null, createdBy: { type: 'AGENT', id: 'agent-1' },
      approval: { mode: 'REQUEST', approverId: 'user-2', approvedAt: APPROVED_AT.toISOString(), approvalRequestId: 'request-1' },
    });
  });
});
