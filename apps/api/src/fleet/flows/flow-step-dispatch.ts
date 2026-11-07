import { Prisma } from '../../generated/prisma/client';
import type { DispatchFleetJobDto } from '../jobs/dto/dispatch-fleet-job.dto';
import type { FlowStep } from './flow-steps';
import { buildReviewTask } from './flow-steps';

const MIN_REMAINING_CAP_USD = new Prisma.Decimal('0.0001');

/** Return the usable flow budget, rounded down to the dispatch DTO's four-decimal precision. */
export function remainingCapUsd(capUsd: string, spentUsd: string): string | null {
  const remaining = new Prisma.Decimal(capUsd).minus(spentUsd).toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN);
  return remaining.lt(MIN_REMAINING_CAP_USD) ? null : remaining.toFixed(4);
}

export interface BuildStepDispatchInput {
  flow: {
    repoId: string;
    branch: string;
    specSha: string;
    reviewerRole: string;
    pinnedRunnerId: string | null;
  };
  feature: { feature: string; specPath: string };
  step: FlowStep;
  remainingCapUsd: string;
  reviewAgent: string;
  plan?: { resultSha: string | null; resultBranch: string | null };
  pr?: { number: number };
}

export function buildStepDispatch(input: BuildStepDispatchInput): DispatchFleetJobDto {
  const { flow, feature, step } = input;
  const common = {
    repoId: flow.repoId,
    maxCostUsd: new Prisma.Decimal(input.remainingCapUsd).toNumber(),
    ...(flow.pinnedRunnerId !== null ? { pinnedRunnerId: flow.pinnedRunnerId } : {}),
  };

  switch (step) {
    case 'SPEC_REVIEW':
    case 'PRD_REVIEW': {
      const ref = step === 'SPEC_REVIEW' ? flow.specSha : requirePlan(input, step).resultSha;
      if (!ref) throw new Error(`${step} requires a PLAN result sha`);
      return {
        ...common,
        command: 'AGENT',
        feature: feature.feature,
        ref,
        bashMode: 'raw',
        agent: {
          name: input.reviewAgent,
          task: buildReviewTask(step, feature.specPath, feature.feature),
          model: flow.reviewerRole,
        },
      };
    }
    case 'PLAN':
      return {
        ...common, command: 'PLAN', ref: flow.branch, feature: feature.feature,
        planFrom: feature.specPath, profiles: [],
      };
    case 'RUN':
      return {
        ...common, command: 'RUN', ref: requirePlan(input, step).resultBranch,
        feature: feature.feature, profiles: [],
      };
    case 'REVIEW':
    case 'FIX':
      if (!input.pr) throw new Error(`${step} requires a PR number`);
      return {
        ...common, command: step, prNumber: input.pr.number, profiles: [],
      };
  }
}

function requirePlan(input: BuildStepDispatchInput, step: FlowStep): NonNullable<BuildStepDispatchInput['plan']> {
  if (!input.plan) throw new Error(`${step} requires the missing PLAN job`);
  return input.plan;
}
