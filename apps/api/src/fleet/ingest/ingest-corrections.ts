import { Prisma } from '../../generated/prisma/client';
import { FleetJobState } from '../../common/enums';
import type { FleetJobPatch, FleetJobRecord, FleetJobWorkflow } from '../jobs/domain/fleet-job.domain';
import type { FinishInfo } from './parsers/finish.parser';

export const ESCALATED_FROM_AUDIT = 'finish escalated (from finish-audit)';
export const ESCALATED_FROM_WORKFLOW = 'workflow draft (from status)';
export const NOTHING_PUSHED = 'completed; nothing pushed (finish disabled or skipped)';

export interface CorrectionInput {
  job: Pick<FleetJobRecord, 'state' | 'command' | 'leaseEpoch' | 'costSpentUsd' | 'stateReason' | 'finishResult' | 'escalationReason' | 'resultPrUrl' | 'resultBranch' | 'resultSha' | 'workflow'>;
  leaseEpoch: number;
  ledgerCostUsd: string;
  runStatus: string | null;
  finish: FinishInfo | null;
  workflow: FleetJobWorkflow | null;
  workflowOutcome: 'ready' | 'draft' | 'local-only' | null;
  workflowUrl: string | null;
}

export interface Correction {
  patch: FleetJobPatch;
  costRaised: boolean;
  escalated: boolean;
  escalatedFrom: 'finish-audit' | 'workflow' | null;
  liveCostUsd: string | null;
}

const round4 = (v: string) => new Prisma.Decimal(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const fill = <K extends keyof FleetJobPatch>(current: string | null, value: string | null, key: K): FleetJobPatch =>
  current === null && value !== null ? ({ [key]: value } as FleetJobPatch) : {};

/** Spec §3, D367: what ingest changes on the job row. Pure; the caller holds the job lock. */
export function computeCorrection(input: CorrectionInput): Correction {
  const { job, finish } = input;
  if (input.leaseEpoch !== job.leaseEpoch) return { patch: {}, costRaised: false, escalated: false, escalatedFrom: null, liveCostUsd: null };
  // Tolerate callers (unit mocks) that omit the US-005 workflow inputs: treat missing as null.
  const parsedWorkflow = (input.workflow ?? null) as FleetJobWorkflow | null;
  const workflowOutcome = (input.workflowOutcome ?? null) as CorrectionInput['workflowOutcome'];
  const workflowUrl = (input.workflowUrl ?? null) as string | null;

  const ledger = round4(input.ledgerCostUsd);
  const costRaised = ledger.gt(new Prisma.Decimal(job.costSpentUsd));
  const cost: FleetJobPatch = costRaised ? { costSpentUsd: ledger.toFixed(4) } : {};

  // A status workflow outcome is authoritative; finish-audit data is legacy fallback only.
  const usable = job.command === 'RUN' && workflowOutcome === null && input.runStatus === 'completed' && finish !== null ? finish : null;
  const fields: FleetJobPatch = usable
    ? {
      ...fill(job.finishResult, usable.status, 'finishResult'),
      ...fill(job.escalationReason, usable.escalationReason, 'escalationReason'),
      ...fill(job.resultPrUrl, usable.prUrl, 'resultPrUrl'),
      ...fill(job.resultBranch, usable.branch, 'resultBranch'),
      ...fill(job.resultSha, usable.headSha, 'resultSha'),
    }
    : {};
  const finishEscalated = usable !== null && usable.status === 'escalated' && job.state === FleetJobState.COMPLETED;

  // US-005: workflow rules apply to RUN jobs only, fill-only, after the lease guard.
  const isRun = job.command === 'RUN';
  const workflowPatch: FleetJobPatch =
    isRun && job.workflow === null && parsedWorkflow !== null ? { workflow: parsedWorkflow } : {};
  // Fill resultPrUrl from the workflow url when the job has none and the finish record did not fill one.
  const finishPrUrl = usable?.prUrl ?? null;
  const workflowPrPatch: FleetJobPatch =
    isRun && job.resultPrUrl === null && finishPrUrl === null && workflowUrl !== null
      ? { resultPrUrl: workflowUrl }
      : {};
  const workflowEscalated = isRun && workflowOutcome === 'draft' && job.state === FleetJobState.COMPLETED;

  // Workflow takes precedence when both signals escalate; the source tracks which reason won.
  const escalated = workflowEscalated || finishEscalated;
  const escalatedFrom: Correction['escalatedFrom'] = workflowEscalated ? 'workflow' : finishEscalated ? 'finish-audit' : null;
  const state: FleetJobPatch = workflowEscalated
    ? { state: FleetJobState.ESCALATED, stateReason: ESCALATED_FROM_WORKFLOW }
    : finishEscalated
      ? { state: FleetJobState.ESCALATED, stateReason: ESCALATED_FROM_AUDIT }
      : {};

  const finishSilent = finish === null || finish.status === 'skipped';
  const branchAfter = job.resultBranch ?? (fields.resultBranch as string | undefined) ?? null;
  // US-005: the NOTHING_PUSHED reason is never applied when a workflow outcome is present.
  const nothingPushed = !escalated && workflowOutcome === null && job.state === FleetJobState.COMPLETED && job.command === 'RUN' && finishSilent && branchAfter === null && job.stateReason === null;
  const reason: FleetJobPatch = nothingPushed ? { stateReason: NOTHING_PUSHED } : {};

  return { patch: { ...cost, ...fields, ...workflowPatch, ...workflowPrPatch, ...state, ...reason }, costRaised, escalated, escalatedFrom, liveCostUsd: job.costSpentUsd };
}
