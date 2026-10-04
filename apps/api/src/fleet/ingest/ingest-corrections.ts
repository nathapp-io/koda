import { Prisma } from '@prisma/client';
import { FleetJobState } from '../../common/enums';
import type { FleetJobPatch, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FinishInfo } from './parsers/finish.parser';

export const ESCALATED_FROM_AUDIT = 'finish escalated (from finish-audit)';
export const NOTHING_PUSHED = 'completed; nothing pushed (finish disabled or skipped)';

export interface CorrectionInput {
  job: Pick<FleetJobRecord, 'state' | 'command' | 'leaseEpoch' | 'costSpentUsd' | 'stateReason' | 'finishResult' | 'escalationReason' | 'resultPrUrl' | 'resultBranch' | 'resultSha'>;
  leaseEpoch: number;
  ledgerCostUsd: string;
  runStatus: string | null;
  finish: FinishInfo | null;
}

export interface Correction {
  patch: FleetJobPatch;
  costRaised: boolean;
  escalated: boolean;
  liveCostUsd: string | null;
}

const round4 = (v: string) => new Prisma.Decimal(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const fill = <K extends keyof FleetJobPatch>(current: string | null, value: string | null, key: K): FleetJobPatch =>
  current === null && value !== null ? ({ [key]: value } as FleetJobPatch) : {};

/** Spec §3, D367: what ingest changes on the job row. Pure; the caller holds the job lock. */
export function computeCorrection(input: CorrectionInput): Correction {
  const { job, finish } = input;
  if (input.leaseEpoch !== job.leaseEpoch) return { patch: {}, costRaised: false, escalated: false, liveCostUsd: null };

  const ledger = round4(input.ledgerCostUsd);
  const costRaised = ledger.gt(new Prisma.Decimal(job.costSpentUsd));
  const cost: FleetJobPatch = costRaised ? { costSpentUsd: ledger.toFixed(4) } : {};

  const usable = job.command === 'RUN' && input.runStatus === 'completed' && finish !== null ? finish : null;
  const fields: FleetJobPatch = usable
    ? {
      ...fill(job.finishResult, usable.status, 'finishResult'),
      ...fill(job.escalationReason, usable.escalationReason, 'escalationReason'),
      ...fill(job.resultPrUrl, usable.prUrl, 'resultPrUrl'),
      ...fill(job.resultBranch, usable.branch, 'resultBranch'),
      ...fill(job.resultSha, usable.headSha, 'resultSha'),
    }
    : {};
  const escalated = usable !== null && usable.status === 'escalated' && job.state === FleetJobState.COMPLETED;
  const state: FleetJobPatch = escalated ? { state: FleetJobState.ESCALATED, stateReason: ESCALATED_FROM_AUDIT } : {};

  const finishSilent = finish === null || finish.status === 'skipped';
  const branchAfter = job.resultBranch ?? (fields.resultBranch as string | undefined) ?? null;
  const nothingPushed = !escalated && job.state === FleetJobState.COMPLETED && job.command === 'RUN' && finishSilent && branchAfter === null && job.stateReason === null;
  const reason: FleetJobPatch = nothingPushed ? { stateReason: NOTHING_PUSHED } : {};

  return { patch: { ...cost, ...fields, ...state, ...reason }, costRaised, escalated, liveCostUsd: job.costSpentUsd };
}
