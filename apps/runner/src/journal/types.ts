import type { AssignPayload, FleetJobKindName, FleetJobStateName, RunnerEvent, RunnerEventType } from '@nathapp/fleet-protocol';

export interface JobRow {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly command: FleetJobKindName;
  readonly state: FleetJobStateName;
  readonly repoKey: string;
  readonly branch: string | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly naxRunId: string | null;
  readonly logPath: string | null;
  readonly jobDir: string;
  readonly assign: AssignPayload;
  readonly cancelRequestedAt: string | null;
  readonly resultBranch: string | null;
  readonly resultSha: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt: string | null;
}

export interface NewJob {
  readonly assign: AssignPayload;
  readonly leaseEpoch: number;
  readonly repoKey: string;
  readonly jobDir: string;
}

export type JobPatch = Partial<Pick<JobRow, 'state' | 'branch' | 'pid' | 'pgid' | 'naxRunId' | 'logPath' | 'cancelRequestedAt' | 'resultBranch' | 'resultSha'>>;

export interface EventRow {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly seq: number;
  readonly type: RunnerEventType;
  readonly payload: RunnerEvent['payload'];
  readonly createdAt: string;
  readonly acked: boolean;
}

export interface CommandRecord {
  readonly commandId: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly type: string;
  readonly result: 'ok' | 'rejected';
  readonly detail: string | null;
  readonly appliedAt: string;
}
